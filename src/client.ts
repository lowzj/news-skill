import { DEFAULT_API_URL, VERSION } from './meta.js';
import type { CatalogEntry, Digest, DigestParams, DaysResponse, NewsAPI, NewsImage, NewsItem, Topic, TopicsResponse, TravelEntry } from './types.js';

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

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be boolean`);
  return value;
}

function number(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalid(`${label} must be a number from ${minimum} to ${maximum}`);
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

function timezone(value: unknown): string {
  const result = string(value, 'timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: result }); } catch { invalid('timezone must be an IANA timezone'); }
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
  };
}

function parseImage(value: unknown): NewsImage {
  const row = object(value, 'image');
  return {
    url: string(row.url, 'image.url'),
    source_url: string(row.source_url, 'image.source_url'),
    caption: string(row.caption, 'image.caption'),
    caption_en: string(row.caption_en, 'image.caption_en'),
    credit: string(row.credit, 'image.credit'),
    ...(row.width !== undefined ? { width: integer(row.width, 'image.width', 1) } : {}),
    ...(row.height !== undefined ? { height: integer(row.height, 'image.height', 1) } : {}),
  };
}

function parseCatalog(value: unknown): CatalogEntry {
  const row = object(value, 'catalog');
  return {
    kind: string(row.kind, 'catalog.kind'),
    name: string(row.name, 'catalog.name'),
    name_en: string(row.name_en, 'catalog.name_en'),
    path: string(row.path, 'catalog.path'),
    role: string(row.role, 'catalog.role'),
  };
}

function parseTravel(value: unknown): TravelEntry {
  const row = object(value, 'travel');
  const place = object(row.place, 'travel.place');
  return {
    lang: string(row.lang, 'travel.lang'),
    text: string(row.text, 'travel.text'),
    spot: string(row.spot, 'travel.spot'),
    spot_en: string(row.spot_en, 'travel.spot_en'),
    photos: array(row.photos, 'travel.photos').map(parseImage),
    place: {
      slug: string(place.slug, 'place.slug'),
      name: string(place.name, 'place.name'),
      name_en: string(place.name_en, 'place.name_en'),
      country: string(place.country, 'place.country'),
      country_en: string(place.country_en, 'place.country_en'),
      latitude: number(place.latitude, 'place.latitude', -90, 90),
      longitude: number(place.longitude, 'place.longitude', -180, 180),
      tagline: optionalString(place.tagline, 'place.tagline'),
      tagline_en: optionalString(place.tagline_en, 'place.tagline_en'),
      fact: optionalString(place.fact, 'place.fact'),
      fact_en: optionalString(place.fact_en, 'place.fact_en'),
    },
  };
}

function parseItem(value: unknown): NewsItem {
  const row = object(value, 'item');
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
    tags_en: array(row.tags_en, 'item.tags_en').map((tag) => string(tag, 'tag_en')),
    importance: integer(row.importance, 'item.importance', 1, 5),
    pinned: boolean(row.pinned, 'item.pinned'),
    image: row.image === null ? null : parseImage(row.image),
    ...(row.catalog !== undefined ? { catalog: parseCatalog(row.catalog) } : {}),
    ...(row.travel !== undefined ? { travel: parseTravel(row.travel) } : {}),
  };
}

export interface InsightSignal {
  title: string;
  title_en: string;
  summary: string;
  summary_en: string;
  source_indexes: number[];
}

export interface InsightStory extends InsightSignal {
  short_summary: string;
  status: string;
}

export interface InsightHotspot extends InsightStory { angle: string; angle_en: string }
export interface InsightOutlook extends InsightSignal { kind: string }
export interface InsightFigure { value: string; value_en: string; label: string; label_en: string; source_indexes: number[] }
export interface InsightImage extends NewsImage { index: number; title: string; title_en: string; cover: boolean; archived: boolean }

export interface InsightSource {
  index: number;
  title: string;
  title_en: string;
  url: string;
  source: string;
}

export interface InsightDocument {
  briefing_day: string;
  timezone: string;
  generated_at: string;
  window_start: string;
  window_end: string;
  trend_window_start: string;
  model: string;
  images: InsightImage[];
  sampling: { current_items: number; seven_day_items: number; observed_days: number };
  hotspots: InsightHotspot[];
  gossip: InsightStory[];
  picture_source_indexes: number[];
  headline: string;
  headline_en: string;
  changes: string;
  changes_en: string;
  figures: InsightFigure[];
  watch_signals: InsightSignal[];
  changes_source_indexes: number[];
  cover_source_index: number | null;
  outlook: InsightOutlook[];
  sources: InsightSource[];
  research_sources: { url: string; title: string }[];
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
    return { topics: array(data.topics, 'topics').map(value => {
      const row = object(value, 'topic');
      return { ...parseTopic(row), today_count: integer(row.today_count, 'topic.today_count') };
    }) };
  }

  async days(topic?: string, limit = 30): Promise<DaysResponse> {
    const data = object(await this.get('days', { topic, limit }), 'days response');
    return { topic: optionalString(data.topic, 'topic'), days: array(data.days, 'days').map((value) => {
      const row = object(value, 'day');
      return { day: date(row.day, 'day.day'), count: integer(row.count, 'day.count') };
    }) };
  }

  async digest(params: DigestParams = {}): Promise<Digest> {
    const data = object(await this.get('digest', { topic: params.topic, day: params.day, limit: params.limit, after: params.after }), 'digest response');
    return {
      day: data.day === null ? null : date(data.day, 'day'),
      timezone: timezone(data.timezone),
      topics: array(data.topics, 'topics').map((value) => {
        const row = object(value, 'topic digest');
        return {
          ...parseTopic(row),
          revision: integer(row.revision, 'topic.revision'),
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
    const signal = (value: unknown): InsightSignal => {
      const row = object(value, 'signal');
      return {
        title: string(row.title, 'signal.title'), title_en: string(row.title_en, 'signal.title_en'),
        summary: string(row.summary, 'signal.summary'), summary_en: string(row.summary_en, 'signal.summary_en'),
        source_indexes: indexes(row.source_indexes),
      };
    };
    const story = (value: unknown): InsightStory => {
      const row = object(value, 'story');
      return { ...signal(row), short_summary: string(row.short_summary, 'story.short_summary'), status: string(row.status, 'story.status') };
    };
    const sampling = object(row.sampling, 'sampling');
    return { insight: {
      briefing_day: date(row.briefing_day, 'insight.briefing_day'),
      timezone: timezone(row.timezone),
      generated_at: timestamp(row.generated_at, 'insight.generated_at', false)!,
      window_start: timestamp(row.window_start, 'insight.window_start', false)!,
      window_end: timestamp(row.window_end, 'insight.window_end', false)!,
      trend_window_start: timestamp(row.trend_window_start, 'insight.trend_window_start', false)!,
      model: string(row.model, 'insight.model'),
      images: array(row.images, 'images').map(value => {
        const image = object(value, 'insight image');
        return { ...parseImage(image), index: integer(image.index, 'image.index'),
          title: string(image.title, 'image.title'), title_en: string(image.title_en, 'image.title_en'),
          cover: boolean(image.cover, 'image.cover'), archived: boolean(image.archived, 'image.archived') };
      }),
      sampling: {
        current_items: integer(sampling.current_items, 'sampling.current_items'),
        seven_day_items: integer(sampling.seven_day_items, 'sampling.seven_day_items'),
        observed_days: integer(sampling.observed_days, 'sampling.observed_days'),
      },
      hotspots: array(row.hotspots, 'hotspots').map(value => {
        const hotspot = object(value, 'hotspot');
        return { ...story(hotspot), angle: string(hotspot.angle, 'hotspot.angle'), angle_en: string(hotspot.angle_en, 'hotspot.angle_en') };
      }),
      gossip: array(row.gossip, 'gossip').map(story),
      picture_source_indexes: indexes(row.picture_source_indexes),
      headline: string(row.headline, 'headline'), headline_en: string(row.headline_en, 'headline_en'),
      changes: string(row.changes, 'changes'), changes_en: string(row.changes_en, 'changes_en'),
      figures: array(row.figures, 'figures').map(value => {
        const figure = object(value, 'figure');
        return { value: string(figure.value, 'figure.value'), value_en: string(figure.value_en, 'figure.value_en'),
          label: string(figure.label, 'figure.label'), label_en: string(figure.label_en, 'figure.label_en'), source_indexes: indexes(figure.source_indexes) };
      }),
      watch_signals: array(row.watch_signals, 'watch_signals').map(signal),
      changes_source_indexes: indexes(row.changes_source_indexes),
      cover_source_index: row.cover_source_index === null ? null : integer(row.cover_source_index, 'cover_source_index'),
      outlook: array(row.outlook, 'outlook').map(value => {
        const outlook = object(value, 'outlook');
        return { ...signal(outlook), kind: string(outlook.kind, 'outlook.kind') };
      }),
      sources: array(row.sources, 'sources').map((value) => {
        const source = object(value, 'source');
        return { index: integer(source.index, 'source.index'), title: string(source.title, 'source.title'),
          title_en: string(source.title_en, 'source.title_en'), url: string(source.url, 'source.url'), source: string(source.source, 'source.source') };
      }),
      research_sources: array(row.research_sources, 'research_sources').map((value) => {
        const source = object(value, 'research source');
        return { title: string(source.title, 'research source.title'), url: string(source.url, 'research source.url') };
      }),
    } };
  }
}
