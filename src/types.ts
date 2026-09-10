export interface Topic {
  id: string;
  name: string;
  name_en: string;
  description: string;
  latest_day: string | null;
  updated_at: string | null;
  today_count?: number;
}

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  title_en: string;
  summary_en: string;
  url: string;
  source: string;
  published_at: string | null;
  first_seen_at: string;
  tags: string[];
  importance: number;
  pinned: boolean;
}

export interface TopicDigest extends Topic {
  total: number;
  next: string | null;
  items: NewsItem[];
}

export interface Digest {
  day: string | null;
  timezone: string;
  generated_at: string;
  topics: TopicDigest[];
}

export interface DayCount { day: string; count: number }
export interface DaysResponse { days: DayCount[] }
export interface TopicsResponse { topics: Topic[] }

export interface DigestParams {
  topic?: string;
  day?: string;
  limit?: number;
  after?: string;
}

export interface NewsAPI {
  topics(): Promise<TopicsResponse>;
  days(topic?: string, limit?: number): Promise<DaysResponse>;
  digest(params?: DigestParams): Promise<Digest>;
}

export interface SelectionOptions {
  topic?: string;
  day?: string;
  days?: number;
  from?: string;
  to?: string;
  limit?: number;
  sort?: 'latest' | 'importance';
  minImportance?: number;
  maxPages?: number;
  query?: string;
}

export interface ResultItem extends NewsItem {
  topic_ids: string[];
  topic_names: string[];
  days: string[];
}

export interface QueryResult {
  query: string | null;
  retrieved_at: string;
  timezone: string;
  sort: 'latest' | 'importance';
  returned: number;
  matched: number;
  items: ResultItem[];
  sources: { topic_id: string; day: string; updated_at: string | null }[];
  coverage: {
    complete: boolean;
    pages_fetched: number;
    max_pages: number;
    days: string[];
    topic_ids: string[];
    reason: 'max_pages' | null;
  };
}
