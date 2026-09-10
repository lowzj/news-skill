import assert from 'node:assert/strict';
import test from 'node:test';
import { queryNews } from '../skills/news/scripts/query.js';

const NOW = new Date('2026-09-09T16:05:00.000Z');
const TODAY = '2026-09-10';

function item(id, overrides = {}) {
  return {
    id, title: `新闻 ${id}`, summary: '', title_en: `News ${id}`, summary_en: '',
    url: `https://example.com/${id}`, source: 'Example', published_at: `${TODAY}T00:00:00Z`,
    first_seen_at: `${TODAY}T00:00:00Z`, tags: [], importance: 3, pinned: false,
    ...overrides,
  };
}

function topic(id, items = [], next = null, overrides = {}) {
  return {
    id, name: id.toUpperCase(), name_en: id, description: '', latest_day: TODAY,
    updated_at: '2026-09-09T16:01:00Z', total: items.length, next, items,
    ...overrides,
  };
}

function digest(day, topics, overrides = {}) {
  return { day, topics, timezone: 'Asia/Shanghai', generated_at: NOW.toISOString(), ...overrides };
}

function api(respond) {
  const calls = [];
  return {
    calls,
    async digest(params) {
      calls.push(params);
      return respond(params, calls.length);
    },
    async topics() { throw new Error('Unexpected topics request'); },
    async days() { throw new Error('Unexpected days request'); },
  };
}

test('scans later pages before applying the global limit and locks topic/day for cursors', async () => {
  const client = api((params, call) => {
    if (call === 1) return digest(TODAY, [
      topic('openai', [item('old', { title: 'Claude Code', importance: 1 })], 'opaque+cursor/='),
      topic('anthropic', [item('other', { title: 'Claude Code', importance: 2 })]),
    ]);
    assert.deepEqual(params, { topic: 'openai', day: TODAY, limit: 128, after: 'opaque+cursor/=' });
    return digest(TODAY, [topic('openai', [item('best', { title: 'Claude Code', importance: 5 })])]);
  });
  const result = await queryNews(client, { query: 'claude code', limit: 1, sort: 'importance' }, NOW);
  assert.equal(client.calls.length, 2);
  assert.equal(result.items[0].id, 'best');
  assert.equal(result.returned, 1);
  assert.equal(result.matched, 3);
  assert.equal(result.coverage.complete, true);
});

test('finds literal bilingual, source and tag phrases using NFKC normalization', async () => {
  const client = api(() => digest(TODAY, [topic('news', [
    item('english', { summary_en: 'A new Ｃｌａｕｄｅ Ｃｏｄｅ update' }),
    item('source', { source: 'Claude Code Team' }),
    item('tag', { tags: ['Claude Code'] }),
    item('not-phrase', { title: 'Claude improves its new Code features' }),
  ], 'second')]));
  const result = await queryNews(client, { query: 'CLAUDE CODE', maxPages: 1 }, NOW);
  assert.deepEqual(result.items.map(row => row.id).sort(), ['english', 'source', 'tag']);
  assert.equal(result.coverage.complete, false);
});

test('finds a match present only on a later page and keeps independent topic cursors', async () => {
  const client = api((params, call) => {
    if (call === 1) return digest(TODAY, [
      topic('openai', [item('irrelevant-one')], 'same-cursor'),
      topic('anthropic', [item('irrelevant-two')], 'same-cursor'),
    ]);
    assert.equal(params.after, 'same-cursor');
    assert.equal(params.day, TODAY);
    return digest(TODAY, [topic(params.topic, params.topic === 'anthropic'
      ? [item('match', { summary: '发布了新的 Claude Code 功能' })]
      : [item('irrelevant-three')])]);
  });
  const result = await queryNews(client, { query: 'Claude Code' }, NOW);
  assert.deepEqual(result.items.map(row => row.id), ['match']);
  assert.deepEqual(client.calls.slice(1).map(call => call.topic), ['openai', 'anthropic']);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.pages_fetched, 3);
});

test('does not mistake a recent generated_at for the latest available content day', async () => {
  const client = api(() => digest('2026-09-05', [topic('news', [item('stale')], null, {
    updated_at: '2026-09-05T10:00:00Z', latest_day: '2026-09-05',
  })]));
  const result = await queryNews(client, {}, NOW);
  assert.deepEqual(result.coverage.days, ['2026-09-05']);
  assert.deepEqual(result.items[0].days, ['2026-09-05']);
  assert.equal(result.sources[0].updated_at, '2026-09-05T10:00:00Z');
  assert.equal(result.retrieved_at, NOW.toISOString());
  assert.equal(client.calls.length, 1);
});

test('today uses service timezone across UTC midnight, with stale discovery excluded from page budget', async () => {
  const client = api((params, call) => call === 1
    ? digest('2026-09-08', [topic('news', [item('stale')])])
    : digest(params.day, [topic('news')]));
  const result = await queryNews(client, { day: 'today', maxPages: 1 }, NOW);
  assert.equal(client.calls[1].day, TODAY);
  assert.deepEqual(result.coverage.days, [TODAY]);
  assert.equal(result.coverage.pages_fetched, 1);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.items.length, 0);
});

test('yesterday resolves in service timezone and reuses a matching discovery page', async () => {
  const client = api(() => digest('2026-09-09', [topic('news', [item('yesterday')])]));
  const result = await queryNews(client, { day: 'yesterday' }, NOW);
  assert.deepEqual(result.coverage.days, ['2026-09-09']);
  assert.equal(client.calls.length, 1);
  assert.equal(result.coverage.pages_fetched, 1);
});

test('relative days enumerate calendar dates, including empty days, and reuse discovery', async () => {
  const client = api(params => digest(params.day ?? TODAY, [topic('news')]));
  const result = await queryNews(client, { days: 3 }, NOW);
  assert.deepEqual(result.coverage.days, [TODAY, '2026-09-09', '2026-09-08']);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.pages_fetched, 3);
  assert.equal(client.calls.length, 3);
});

test('deduplicates transitively by ID and normalized source URL, retaining associations', async () => {
  const client = api(params => digest(params.day, params.day === TODAY ? [
    topic('openai', [item('one', { url: 'https://example.com/a?utm_source=feed#section', pinned: true })]),
    topic('anthropic', [item('two', { url: 'https://example.com/b?edition=1', importance: 5 })]),
  ] : [
    topic('openai', [item('one', { url: 'https://example.com/b?edition=1&gclid=123', tags: ['merge'] })]),
    topic('anthropic', [item('three', { url: 'https://example.com/a?fbclid=123', tags: ['source'] })]),
  ]));
  const result = await queryNews(client, { from: '2026-09-09', to: TODAY }, NOW);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.items[0].topic_ids, ['anthropic', 'openai']);
  assert.deepEqual(result.items[0].topic_names, ['ANTHROPIC', 'OPENAI']);
  assert.deepEqual(result.items[0].days, [TODAY, '2026-09-09']);
  assert.deepEqual(result.items[0].tags.sort(), ['merge', 'source']);
  assert.equal(result.items[0].pinned, true);
  assert.equal(result.items[0].importance, 5);
  assert.equal(result.sources.length, 4);
});

test('preserves semantic URL query parameters and does not deduplicate missing URLs', async () => {
  const client = api(() => digest(TODAY, [topic('news', [
    item('one', { url: 'https://example.com/article?id=1' }),
    item('two', { url: 'https://example.com/article?id=2' }),
    item('three', { url: '' }), item('four', { url: '' }),
  ])]));
  const result = await queryNews(client, {}, NOW);
  assert.equal(result.matched, 4);
});

test('latest ranking ignores pinned ordering and falls back to first_seen_at', async () => {
  const client = api(() => digest(TODAY, [topic('news', [
    item('pinned-old', { pinned: true, published_at: '2026-09-08T00:00:00Z' }),
    item('newest', { published_at: null, first_seen_at: '2026-09-10T02:00:00Z' }),
    item('recent', { published_at: '2026-09-10T01:00:00Z' }),
  ])]));
  const result = await queryNews(client, {}, NOW);
  assert.deepEqual(result.items.map(row => row.id), ['newest', 'recent', 'pinned-old']);
  assert.equal(result.items[2].pinned, true);
});

test('importance filtering and ranking apply globally across dates', async () => {
  const client = api(params => digest(params.day, [topic('news', params.day === TODAY
    ? [item('low', { importance: 1 }), item('good', { importance: 3 })]
    : [item('best', { importance: 5, published_at: '2026-09-09T00:00:00Z' })])]));
  const result = await queryNews(client, {
    from: '2026-09-09', to: TODAY, minImportance: 3, sort: 'importance', limit: 1,
  }, NOW);
  assert.equal(result.items[0].id, 'best');
  assert.equal(result.matched, 2);
  assert.equal(result.coverage.pages_fetched, 2);
});

test('maxPages bounds digest scanning and reports all requested dates even when truncated', async () => {
  const client = api(params => digest(params.day, [topic('news', [item('first')], 'more')]));
  const result = await queryNews(client, { from: '2026-09-09', to: TODAY, maxPages: 1 }, NOW);
  assert.equal(client.calls.length, 1);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'max_pages');
  assert.equal(result.coverage.pages_fetched, 1);
  assert.deepEqual(result.coverage.days, [TODAY, '2026-09-09']);
});

test('exactly exhausted page budget is complete only when no date or cursor remains', async () => {
  const client = api(params => digest(params.day, [topic('news')]));
  const result = await queryNews(client, { from: '2026-09-09', to: TODAY, maxPages: 1 }, NOW);
  assert.equal(result.coverage.complete, false);
  const single = await queryNews(client, { day: TODAY, maxPages: 1 }, NOW);
  assert.equal(single.coverage.complete, true);
});

test('rejects invalid selectors before making any request', async () => {
  const client = api(() => { throw new Error('No request should be made'); });
  for (const options of [
    { day: '2026-02-29' }, { day: '2026-09-31' }, { day: '09-10-2026' },
    { day: '' }, { day: TODAY, days: 2 }, { days: 2, from: TODAY, to: TODAY },
    { from: TODAY }, { to: TODAY }, { from: TODAY, to: '2026-09-09' },
    { from: '2026-08-01', to: TODAY }, { days: 32 }, { days: 0 },
    { limit: 101 }, { limit: 0 }, { limit: 1.5 }, { maxPages: 201 },
    { minImportance: 6 }, { sort: 'pinned' }, { topic: ' ' },
  ]) await assert.rejects(queryNews(client, options, NOW));
  assert.equal(client.calls.length, 0);
});

test('accepts valid leap dates and includes both range endpoints', async () => {
  const client = api(params => digest(params.day, [topic('news')]));
  const result = await queryNews(client, { from: '2024-02-28', to: '2024-03-01' }, NOW);
  assert.deepEqual(result.coverage.days, ['2024-03-01', '2024-02-29', '2024-02-28']);
});

test('detects cursor loops promptly instead of claiming coverage or spinning', async () => {
  const client = api(params => digest(params.day ?? TODAY, [topic('news', [], 'loop')]));
  await assert.rejects(queryNews(client, {}, NOW), /repeated a pagination cursor/);
  assert.equal(client.calls.length, 2);
});

test('rejects response day changes while following a cursor', async () => {
  const client = api((params, call) => digest(call === 1 ? '2026-09-09' : TODAY, [
    topic('news', [], call === 1 ? 'next' : null),
  ]));
  await assert.rejects(queryNews(client, {}, NOW), /while requesting 2026-09-09/);
  assert.equal(client.calls[1].day, '2026-09-09');
});

test('rejects an explicit day mismatch without retrying it as metadata', async () => {
  const client = api(() => digest('2026-09-09', [topic('news')]));
  await assert.rejects(queryNews(client, { day: TODAY }, NOW), /while requesting 2026-09-10/);
  assert.equal(client.calls.length, 1);
});

test('single topic selection is retained for discovery and pagination', async () => {
  const client = api((params, call) => {
    assert.equal(params.topic, 'openai');
    return digest(TODAY, [topic('openai', [], call === 1 ? 'next' : null)]);
  });
  const result = await queryNews(client, { topic: 'openai' }, NOW);
  assert.deepEqual(result.coverage.topic_ids, ['openai']);
  assert.equal(result.coverage.pages_fetched, 2);
});

test('empty catalogue preserves a null latest day as an empty complete selection', async () => {
  const client = api(() => digest(null, [topic('news', [], null, { latest_day: null, updated_at: null })]));
  const result = await queryNews(client, {}, NOW);
  assert.deepEqual(result.coverage.days, []);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.pages_fetched, 1);
  assert.deepEqual(result.sources, []);
});
