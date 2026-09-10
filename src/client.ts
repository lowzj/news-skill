import { DEFAULT_API_URL, VERSION } from './meta.js';
import type { Digest, DigestParams, DaysResponse, NewsAPI, NewsItem, Topic, TopicsResponse } from './types.js';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class NewsError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'NewsError';
  }
}

function invalid(message: string): never {
  throw new NewsError('INVALID_RESPONSE', `Invalid NEWS response: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label} must be a string`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label);
}

function timestamp(value: unknown, label: string, nullable = true): string | null {
  if (value === null && nullable) return null;
  const result = string(value, label);
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) invalid(`${label} must be an ISO timestamp`);
  return result;
}

function date(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) {
    invalid(`${label} must be a calendar date`);
  }
  return result;
}

function parseTopic(value: unknown): Topic {
  const row = object(value, 'topic');
  const id = string(row.id, 'topic.id');
  if (!id.trim()) invalid('topic.id must not be empty');
  return {
    id,
    name: string(row.name, 'topic.name'),
    name_en: string(row.name_en, 'topic.name_en'),
    description: string(row.description, 'topic.description'),
    latest_day: row.latest_day === null ? null : date(row.latest_day, 'topic.latest_day'),
    updated_at: timestamp(row.updated_at, 'topic.updated_at'),
    ...(row.today_count !== undefined ? { today_count: integer(row.today_count, 'topic.today_count') } : {}),
  };
}

function parseItem(value: unknown): NewsItem {
  const row = object(value, 'item');
  if (typeof row.pinned !== 'boolean') invalid('item.pinned must be boolean');
  const id = string(row.id, 'item.id');
  if (!id.trim()) invalid('item.id must not be empty');
  return {
    id,
    title: string(row.title, 'item.title'),
    summary: string(row.summary, 'item.summary'),
    title_en: string(row.title_en, 'item.title_en'),
    summary_en: string(row.summary_en, 'item.summary_en'),
    url: string(row.url, 'item.url'),
    source: string(row.source, 'item.source'),
    published_at: timestamp(row.published_at, 'item.published_at'),
    first_seen_at: timestamp(row.first_seen_at, 'item.first_seen_at', false)!,
    tags: array(row.tags, 'item.tags').map((tag) => string(tag, 'tag')),
    importance: integer(row.importance, 'item.importance', 1, 5),
    pinned: row.pinned,
  };
}

export interface InsightSignal {
  title: string;
  title_en: string;
  summary: string;
  summary_en: string;
  source_indexes: number[];
  [key: string]: unknown;
}

export interface InsightSource {
  index: number;
  title: string;
  title_en: string;
  url: string;
  source: string;
  [key: string]: unknown;
}

export interface InsightDocument {
  generated_at: string;
  window_start: string;
  headline: string;
  headline_en: string;
  overview: string;
  overview_en: string;
  changes: string;
  changes_en: string;
  changes_source_indexes: number[];
  wealth: InsightSignal[];
  employment: InsightSignal[];
  risks: InsightSignal[];
  actions: InsightSignal[];
  sources: InsightSource[];
  research_sources: { url: string; title: string }[];
  [key: string]: unknown;
}

export interface InsightResponse { insight: InsightDocument | null }

export class NewsClient implements NewsAPI {
  readonly baseUrl: URL;
  readonly timeoutMs: number;

  constructor(options: { url?: string; timeoutMs?: number } = {}) {
    try {
      this.baseUrl = new URL(options.url ?? process.env.NEWS_API_URL ?? DEFAULT_API_URL);
    } catch {
      throw new NewsError('INVALID_ARGUMENT', '--url / NEWS_API_URL must be an absolute URL');
    }
    const url = this.baseUrl;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new NewsError('INVALID_ARGUMENT', 'Use an HTTPS API URL, or HTTP on localhost for development');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new NewsError('INVALID_ARGUMENT', 'The API URL must not contain credentials, a query, or a fragment');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new NewsError('INVALID_ARGUMENT', 'The request timeout must be between 1 and 120000 milliseconds');
    }
  }

  private async get(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: { accept: 'application/json', 'user-agent': `news-skill/${VERSION}` },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new NewsError('HTTP_ERROR', `NEWS returned HTTP ${response.status} for /${path}; configure the final API URL`);
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              throw new NewsError('RESPONSE_TOO_LARGE', 'NEWS response exceeds 16 MiB');
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let data: unknown;
      try { data = JSON.parse(body); } catch { /* Report HTTP status before JSON errors. */ }
      if (!response.ok) {
        let detail = '';
        if (data && typeof data === 'object' && 'error' in data) {
          const error = data.error;
          if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
            detail = `: ${error.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 400)}`;
          }
        }
        throw new NewsError('HTTP_ERROR', `NEWS returned HTTP ${response.status} for /${path}${detail}`);
      }
      if (data === undefined) invalid(`/${path} did not return JSON`);
      return data;
    } catch (error) {
      if (error instanceof NewsError) throw error;
      if (signal.aborted) throw new NewsError('TIMEOUT', `NEWS request timed out after ${this.timeoutMs / 1000}s for /${path}`);
      const cause = error instanceof Error ? error.message : 'Connection failed';
      throw new NewsError('NETWORK_ERROR', `Could not reach ${this.baseUrl.origin}: ${cause}`);
    }
  }

  async topics(): Promise<TopicsResponse> {
    const data = object(await this.get('topics'), 'topics response');
    return { topics: array(data.topics, 'topics').map(parseTopic) };
  }

  async days(topic?: string, limit = 30): Promise<DaysResponse> {
    const data = object(await this.get('days', { topic, limit }), 'days response');
    return { days: array(data.days, 'days').map((value) => {
      const row = object(value, 'day');
      return { day: date(row.day, 'day.day'), count: integer(row.count, 'day.count') };
    }) };
  }

  async digest(params: DigestParams = {}): Promise<Digest> {
    const data = object(await this.get('digest', { ...params }), 'digest response');
    const timezone = string(data.timezone, 'timezone');
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { invalid('timezone must be an IANA timezone'); }
    return {
      day: data.day === null ? null : date(data.day, 'day'),
      timezone,
      generated_at: timestamp(data.generated_at, 'generated_at', false)!,
      topics: array(data.topics, 'topics').map((value) => {
        const row = object(value, 'topic digest');
        return {
          ...parseTopic(row),
          total: integer(row.total, 'topic.total'),
          next: optionalString(row.next, 'topic.next'),
          items: array(row.items, 'topic.items').map(parseItem),
        };
      }),
    };
  }

  async insight(): Promise<InsightResponse> {
    const data = object(await this.get('insight'), 'insight response');
    if (data.insight === null) return { insight: null };
    const row = object(data.insight, 'insight');
    const indexes = (value: unknown) => array(value, 'source_indexes').map((index) => integer(index, 'source index'));
    const signals = (value: unknown) => array(value, 'signals').map((value) => {
      const signal = object(value, 'signal');
      return {
        ...signal,
        title: string(signal.title, 'signal.title'), title_en: string(signal.title_en, 'signal.title_en'),
        summary: string(signal.summary, 'signal.summary'), summary_en: string(signal.summary_en, 'signal.summary_en'),
        source_indexes: indexes(signal.source_indexes ?? []),
      };
    });
    return { insight: {
      ...row,
      generated_at: timestamp(row.generated_at, 'insight.generated_at', false)!,
      window_start: timestamp(row.window_start, 'insight.window_start', false)!,
      headline: string(row.headline, 'headline'), headline_en: string(row.headline_en, 'headline_en'),
      overview: string(row.overview, 'overview'), overview_en: string(row.overview_en, 'overview_en'),
      changes: string(row.changes, 'changes'), changes_en: string(row.changes_en, 'changes_en'),
      changes_source_indexes: indexes(row.changes_source_indexes ?? []),
      wealth: signals(row.wealth), employment: signals(row.employment), risks: signals(row.risks), actions: signals(row.actions),
      sources: array(row.sources, 'sources').map((value) => {
        const source = object(value, 'source');
        return { ...source, index: integer(source.index, 'source.index'), title: string(source.title, 'source.title'),
          title_en: string(source.title_en, 'source.title_en'), url: string(source.url, 'source.url'), source: string(source.source, 'source.source') };
      }),
      research_sources: array(row.research_sources ?? [], 'research_sources').map((value) => {
        const source = object(value, 'research source');
        return { title: string(source.title, 'research source.title'), url: string(source.url, 'research source.url') };
      }),
    } };
  }
}
