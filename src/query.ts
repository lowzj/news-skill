import type {
  Digest, DigestParams, NewsAPI, NewsItem, QueryResult, ResultItem,
  SelectionOptions, TopicDigest,
} from './types.js';

const PAGE_SIZE = 128;
const DAY_MS = 86_400_000;

function integer(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return result;
}

function parseDay(value: string, name = 'day'): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must be a valid date in YYYY-MM-DD format.`);
  }
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a valid date in YYYY-MM-DD format.`);
  }
  return time;
}

function formatDay(time: number): string {
  const result = new Date(time).toISOString().slice(0, 10);
  parseDay(result);
  return result;
}

function range(from: string, to: string): string[] {
  const start = parseDay(from, 'from');
  const end = parseDay(to, 'to');
  const count = (end - start) / DAY_MS + 1;
  if (count < 1 || count > 31) {
    throw new Error('The date range must be ascending and contain at most 31 days.');
  }
  return Array.from({ length: count }, (_, index) => formatDay(end - index * DAY_MS));
}

function todayInTimezone(now: Date, timezone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
  } catch {
    throw new Error(`The NEWS service returned an invalid timezone: ${timezone}`);
  }
  const part = (kind: string): string => parts.find(entry => entry.type === kind)?.value ?? '';
  const result = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  parseDay(result);
  return result;
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function matchesText(item: NewsItem, query: string): boolean {
  return [item.title, item.summary, item.title_en, item.summary_en, item.source, ...item.tags]
    .some(value => normalizeText(value).includes(query));
}

function normalizedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(fbclid|gclid|msclkid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch {
    // Missing or invalid URLs cannot identify duplicates of different IDs.
    return null;
  }
}

function timestamp(item: NewsItem): number {
  const published = item.published_at === null ? NaN : Date.parse(item.published_at);
  if (Number.isFinite(published)) return published;
  const seen = Date.parse(item.first_seen_at);
  return Number.isFinite(seen) ? seen : 0;
}

function compareLatest(left: NewsItem, right: NewsItem): number {
  return timestamp(right) - timestamp(left)
    || right.importance - left.importance
    || left.id.localeCompare(right.id)
    || left.url.localeCompare(right.url);
}

interface Group {
  item: NewsItem;
  ids: Set<string>;
  urls: Set<string>;
  topics: Map<string, string>;
  days: Set<string>;
  matches: boolean;
}

/** Scan the selected calendar days before ranking and applying the global limit. */
export async function queryNews(
  api: NewsAPI,
  options: SelectionOptions = {},
  now: Date = new Date(),
): Promise<QueryResult> {
  const limit = integer(options.limit, 10, 100, 'limit');
  const maxPages = integer(options.maxPages, 20, 200, 'maxPages');
  const minImportance = integer(options.minImportance, 1, 5, 'minImportance');
  const sort = options.sort ?? 'latest';
  if (sort !== 'latest' && sort !== 'importance') throw new Error('sort must be latest or importance.');
  if (!Number.isFinite(now.getTime())) throw new Error('now must be a valid date.');
  if (options.topic !== undefined && !options.topic.trim()) throw new Error('topic must not be empty.');
  const hasRange = options.from !== undefined || options.to !== undefined;
  const selectors = Number(options.day !== undefined) + Number(options.days !== undefined) + Number(hasRange);
  if (selectors > 1) throw new Error('Use only one of day, days, or from/to.');
  if (hasRange && (options.from === undefined || options.to === undefined)) {
    throw new Error('from and to must be supplied together.');
  }
  const dayCount = options.days === undefined ? undefined : integer(options.days, 1, 31, 'days');
  let selectedDays: string[] | undefined;
  if (hasRange) selectedDays = range(options.from!, options.to!);
  else if (options.day !== undefined && options.day !== 'today' && options.day !== 'yesterday') {
    parseDay(options.day);
    selectedDays = [options.day];
  }

  const query = options.query?.trim() || null;
  const needle = normalizeText(query ?? '');
  const params = (day?: string, topic = options.topic, after?: string): DigestParams => ({
    ...(topic !== undefined ? { topic } : {}),
    ...(day !== undefined ? { day } : {}),
    limit: PAGE_SIZE,
    ...(after !== undefined ? { after } : {}),
  });

  // For relative selectors this call discovers the service timezone. Its page is
  // reused when it belongs to the requested days; otherwise it is metadata only.
  const initial = await api.digest(params(selectedDays?.[0]));
  if (selectedDays !== undefined && initial.day !== selectedDays[0]) {
    throw new Error(`The NEWS service returned day ${initial.day ?? 'null'} while requesting ${selectedDays[0]}.`);
  }
  const today = todayInTimezone(now, initial.timezone);
  if (selectedDays === undefined) {
    if (dayCount !== undefined) {
      selectedDays = Array.from({ length: dayCount }, (_, index) => formatDay(parseDay(today) - index * DAY_MS));
    } else if (options.day === 'today' || options.day === 'yesterday') {
      selectedDays = [formatDay(parseDay(today) - (options.day === 'yesterday' ? DAY_MS : 0))];
    } else {
      selectedDays = initial.day === null ? [] : [initial.day];
      if (initial.day !== null) parseDay(initial.day);
    }
  }
  const selectedTopics = initial.topics.filter(topic => options.topic === undefined || topic.id === options.topic);
  if (options.topic !== undefined && selectedTopics.length === 0) {
    throw new Error(`The NEWS service did not return the requested topic: ${options.topic}`);
  }
  const topicIds = new Set(selectedTopics.map(topic => topic.id));
  const sources = new Map<string, QueryResult['sources'][number]>();
  const groups = new Set<Group>();
  const byId = new Map<string, Group>();
  const byUrl = new Map<string, Group>();
  let pagesFetched = 0;
  let complete = true;

  function merge(target: Group, incoming: Group): void {
    const preferred = compareLatest(target.item, incoming.item) <= 0 ? target.item : incoming.item;
    target.item = {
      ...preferred,
      importance: Math.max(target.item.importance, incoming.item.importance),
      pinned: target.item.pinned || incoming.item.pinned,
      tags: [...new Set([...target.item.tags, ...incoming.item.tags])],
    };
    for (const id of incoming.ids) { target.ids.add(id); byId.set(id, target); }
    for (const url of incoming.urls) { target.urls.add(url); byUrl.set(url, target); }
    for (const [id, name] of incoming.topics) target.topics.set(id, name);
    for (const day of incoming.days) target.days.add(day);
    target.matches ||= incoming.matches;
    groups.delete(incoming);
  }

  function collect(topic: TopicDigest, day: string): void {
    topicIds.add(topic.id);
    sources.set(`${topic.id}\n${day}`, { topic_id: topic.id, day, updated_at: topic.updated_at });
    for (const item of topic.items) {
      const url = normalizedUrl(item.url);
      const existingId = item.id ? byId.get(item.id) : undefined;
      const existingUrl = url === null ? undefined : byUrl.get(url);
      const incoming: Group = {
        item: { ...item, tags: [...item.tags] },
        ids: new Set(item.id ? [item.id] : []),
        urls: new Set(url === null ? [] : [url]),
        topics: new Map([[topic.id, topic.name]]),
        days: new Set([day]),
        matches: !needle || matchesText(item, needle),
      };
      const existing = existingId ?? existingUrl;
      if (existing === undefined) {
        groups.add(incoming);
        for (const id of incoming.ids) byId.set(id, incoming);
        for (const key of incoming.urls) byUrl.set(key, incoming);
      } else {
        if (existingId !== undefined && existingUrl !== undefined && existingId !== existingUrl) {
          merge(existingId, existingUrl);
        }
        merge(existing, incoming);
      }
    }
  }

  for (const day of selectedDays) {
    if (pagesFetched >= maxPages) { complete = false; break; }
    const root = initial.day === day ? initial : await api.digest(params(day));
    const queue: { topic: string; cursor: string }[] = [];
    const seen = new Map<string, Set<string>>();
    function consume(digest: Digest, onlyTopic?: string): void {
      if (digest.day !== day) {
        throw new Error(`The NEWS service returned day ${digest.day ?? 'null'} while requesting ${day}.`);
      }
      if (digest.timezone !== initial.timezone) throw new Error('The NEWS service timezone changed during pagination. Retry the query.');
      pagesFetched += 1;
      const topics = digest.topics.filter(topic => (onlyTopic ?? options.topic) === undefined || topic.id === (onlyTopic ?? options.topic));
      if (onlyTopic !== undefined && topics.length === 0) {
        throw new Error(`The NEWS service omitted topic ${onlyTopic} during pagination.`);
      }
      for (const topic of topics) {
        collect(topic, day);
        if (topic.next !== null) {
          if (seen.get(topic.id)?.has(topic.next)) {
            throw new Error(`The NEWS service repeated a pagination cursor for topic ${topic.id} on ${day}.`);
          }
          queue.push({ topic: topic.id, cursor: topic.next });
        }
      }
    }
    consume(root);
    while (queue.length > 0) {
      if (pagesFetched >= maxPages) { complete = false; break; }
      const next = queue.shift()!;
      const cursors = seen.get(next.topic) ?? new Set<string>();
      if (cursors.has(next.cursor)) {
        throw new Error(`The NEWS service repeated a pagination cursor for topic ${next.topic} on ${day}.`);
      }
      cursors.add(next.cursor);
      seen.set(next.topic, cursors);
      consume(await api.digest(params(day, next.topic, next.cursor)), next.topic);
    }
    if (!complete) break;
  }
  // An empty catalogue is still one fully consumed response for an unfiltered query.
  if (selectors === 0 && initial.day === null) pagesFetched = 1;

  const matchedItems: ResultItem[] = [...groups]
    .filter(group => group.matches && group.item.importance >= minImportance)
    .map(group => ({
      ...group.item,
      topic_ids: [...group.topics.keys()].sort(),
      topic_names: [...new Set(group.topics.values())].sort(),
      days: [...group.days].sort().reverse(),
    }));
  matchedItems.sort((left, right) =>
    (sort === 'importance' ? right.importance - left.importance : 0) || compareLatest(left, right));
  const items = matchedItems.slice(0, limit);
  return {
    query,
    retrieved_at: now.toISOString(),
    timezone: initial.timezone,
    sort,
    returned: items.length,
    matched: matchedItems.length,
    items,
    sources: [...sources.values()].sort((a, b) => b.day.localeCompare(a.day) || a.topic_id.localeCompare(b.topic_id)),
    coverage: {
      complete,
      pages_fetched: pagesFetched,
      max_pages: maxPages,
      days: selectedDays,
      topic_ids: [...topicIds].sort(),
      reason: complete ? null : 'max_pages',
    },
  };
}
