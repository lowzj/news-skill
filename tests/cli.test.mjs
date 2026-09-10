import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CLI = fileURLToPath(new URL('../skills/news/scripts/news.js', import.meta.url));
const DAY = '2026-09-09';
const TIME = `${DAY}T10:00:00Z`;
const topic = (extra = {}) => ({
  id: 'openai', name: '人工智能', name_en: 'AI', description: 'Public technology news',
  latest_day: DAY, updated_at: TIME, ...extra,
});
const item = (id, extra = {}) => ({
  id, title: `新闻 ${id}`, summary: `摘要 ${id}`, title_en: `News ${id}`, summary_en: `Summary ${id}`,
  url: `https://example.org/news/${id}`, source: 'Example publisher', published_at: TIME,
  first_seen_at: `${DAY}T11:00:00Z`, tags: ['AI'], importance: 3, pinned: false, ...extra,
});
const digest = (items = [], extra = {}) => ({
  day: DAY, timezone: 'Asia/Shanghai', generated_at: TIME,
  topics: [topic({ items, total: items.length, next: null })], ...extra,
});

function json(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function service(t, respond) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, headers: request.headers, url });
    respond(request, response, url);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function run(url, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, NEWS_API_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function success(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function failure(result, code) {
  assert.equal(result.code, 1, result.stdout || result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  const parsed = JSON.parse(result.stderr);
  assert.equal(typeof parsed.error.message, 'string');
  if (code) assert.equal(parsed.error.code, code);
  return parsed.error;
}

test('public commands issue only GET requests without authentication and keep stdout machine-readable', async t => {
  const server = await service(t, (_request, response, url) => {
    if (url.pathname === '/api/topics') json(response, { topics: [topic()] });
    else if (url.pathname === '/api/days') json(response, { days: [{ day: DAY, count: 12 }] });
    else if (url.pathname === '/api/insight') json(response, { insight: null });
    else json(response, { error: { message: 'unexpected endpoint' } }, 404);
  });
  const base = `${server.url}/api`;
  assert.equal(JSON.parse(success(await run(base, ['topics']))).topics[0].id, 'openai');
  const days = JSON.parse(success(await run(base, ['days', '--topic', 'claude & code', '--limit', '2'])));
  assert.deepEqual(days.days, [{ day: DAY, count: 12 }]);
  assert.deepEqual(JSON.parse(success(await run(base, ['insight']))), { insight: null });
  assert.deepEqual(server.requests.map(request => request.url.pathname), ['/api/topics', '/api/days', '/api/insight']);
  assert.equal(server.requests[1].url.searchParams.get('topic'), 'claude & code');
  assert.equal(server.requests[1].url.searchParams.get('limit'), '2');
  for (const request of server.requests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.accept, 'application/json');
    assert.match(request.headers['user-agent'], /^news-skill\//);
  }
});

test('search follows escaped cursors, ranks across pages, and renders original links with publication and collection dates', async t => {
  const cursor = 'cursor + / &= 下一页';
  const old = item('old', { title: 'Claude Code 旧更新', published_at: `${DAY}T01:00:00Z` });
  const recent = item('recent', { title: 'Claude Code 新更新', summary: '支持新的工作流。', published_at: `${DAY}T12:00:00Z`, importance: 5 });
  const server = await service(t, (_request, response, url) => {
    const next = url.searchParams.get('after');
    json(response, next === null
      ? digest([], { topics: [topic({ items: [old], total: 2, next: cursor })] })
      : digest([recent]));
  });
  const args = ['search', 'Claude Code', '--topic', 'openai', '--day', DAY, '--limit', '1'];
  const data = JSON.parse(success(await run(server.url, args)));
  assert.deepEqual(data.items.map(row => row.id), ['recent']);
  assert.equal(data.matched, 2);
  assert.equal(data.coverage.complete, true);
  assert.equal(data.coverage.pages_fetched, 2);
  assert.equal(server.requests[1].url.searchParams.get('after'), cursor);
  assert.equal(server.requests[1].url.searchParams.get('topic'), 'openai');
  assert.equal(server.requests[1].url.searchParams.get('day'), DAY);
  const markdown = success(await run(server.url, [...args, '--format', 'markdown']));
  assert.match(markdown, /Claude Code 新更新/);
  assert.match(markdown, /支持新的工作流/);
  assert.ok(markdown.includes('[Claude Code 新更新](<https://example.org/news/recent>)'));
  assert.match(markdown, /发布: 2026-09-09 20:00:00 \(Asia\/Shanghai\)/);
  assert.match(markdown, /收录: 2026-09-09 19:00:00 \(Asia\/Shanghai\)/);
  assert.doesNotMatch(markdown, /旧更新/);
});

test('a scan limit is explicit in JSON coverage and readable Markdown', async t => {
  const server = await service(t, (_request, response) => json(response, digest([], {
    topics: [topic({ items: [item('one')], total: 2, next: 'more' })],
  })));
  const args = ['read', '--day', DAY, '--max-pages', '1'];
  const result = JSON.parse(success(await run(server.url, args)));
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.reason, 'max_pages');
  assert.equal(result.coverage.pages_fetched, 1);
  assert.match(success(await run(server.url, [...args, '--format', 'markdown', '--lang', 'en'])), /Partial results.*1-page scan limit/);
  assert.equal(server.requests.length, 2);
});

test('HTTP failures report structured errors without leaking raw HTML or terminal controls', async t => {
  const server = await service(t, (_request, response, url) => {
    if (url.pathname === '/topics') json(response, { error: { message: '\u001b[31mtemporarily unavailable\nretry later' } }, 503);
    else { response.writeHead(502, { 'content-type': 'text/html' }); response.end('<html>private proxy diagnostic</html>'); }
  });
  const unavailable = await run(server.url, ['topics']);
  const error = failure(unavailable, 'HTTP_ERROR');
  assert.match(error.message, /HTTP 503/);
  assert.doesNotMatch(error.message, /[\x00-\x1f\x7f]/);
  const htmlError = failure(await run(server.url, ['days']), 'HTTP_ERROR');
  assert.match(htmlError.message, /HTTP 502/);
  assert.doesNotMatch(htmlError.message, /private proxy diagnostic|<html>/);
});

test('HTML 200, malformed JSON, and unexpected schemas fail without partial stdout', async t => {
  for (const [label, body, contentType] of [
    ['html', '<html>Sign in</html>', 'text/html'],
    ['broken json', '{"topics":', 'application/json'],
    ['wrong schema', '{"topics":[{"id":"openai"}]}', 'application/json'],
  ]) {
    await t.test(label, async inner => {
      const server = await service(inner, (_request, response) => { response.writeHead(200, { 'content-type': contentType }); response.end(body); });
      failure(await run(server.url, ['topics']), 'INVALID_RESPONSE');
    });
  }
});

test('digest schema validation rejects impossible calendar dates and malformed news fields', async t => {
  for (const [label, payload] of [
    ['impossible day', digest([], { day: '2026-02-30' })],
    ['invalid importance', digest([item('bad', { importance: 7 })])],
    ['missing tags', digest([item('bad', { tags: undefined })])],
    ['invalid timezone', digest([], { timezone: 'not/a/timezone' })],
  ]) {
    await t.test(label, async inner => {
      const server = await service(inner, (_request, response) => json(response, payload));
      failure(await run(server.url, ['read', '--day', DAY]), 'INVALID_RESPONSE');
    });
  }
});

test('redirects are rejected without following them', async t => {
  const server = await service(t, (_request, response) => {
    response.writeHead(302, { location: '/private-login' });
    response.end();
  });
  assert.match(failure(await run(server.url, ['topics']), 'HTTP_ERROR').message, /HTTP 302/);
  assert.equal(server.requests.length, 1);
});

test('request timeout covers a body that never finishes', async t => {
  const server = await service(t, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"topics":[');
  });
  const started = Date.now();
  failure(await run(server.url, ['topics', '--timeout', '1']), 'TIMEOUT');
  assert.ok(Date.now() - started < 8_000, 'The body must be aborted rather than waiting indefinitely');
});

test('invalid commands, unsupported flags, repeated options, and date selectors fail before network access', async t => {
  const server = await service(t, (_request, response) => json(response, { topics: [] }));
  const invalidArgs = [
    ['unknown'], ['topics', '--unknown'], ['topics', '--topic', 'openai'],
    ['read', '--topic', 'openai', '--topic', 'claude'], ['read', '--limit', '2', '--limit=3'],
    ['read', '--format', 'xml'], ['read', '--lang', 'fr'], ['read', '--limit', '0'],
    ['read', '--sort', 'random'], ['read', '--timeout', '0'], ['read', '--topic', ''],
    ['search'], ['search', 'Claude', 'Code'], ['read', 'extra'],
    ['read', '--day', '2026-02-30'], ['read', '--day', DAY, '--days', '2'],
    ['read', '--from', DAY], ['read', '--from', DAY, '--to', '2026-09-01'],
    ['skills', 'install'], ['skills', 'show', '--force'],
  ];
  for (const args of invalidArgs) {
    const error = failure(await run(server.url, args));
    assert.ok(['INVALID_ARGUMENT', 'COMMAND_FAILED'].includes(error.code), `${args.join(' ')}: ${error.code}`);
  }
  assert.equal(server.requests.length, 0);
});

test('unsafe API URLs are rejected and an explicit URL overrides NEWS_API_URL', async t => {
  const server = await service(t, (_request, response) => json(response, { topics: [] }));
  for (const url of ['file:///tmp/news', 'javascript:alert(1)', 'http://example.org', 'https://user:pass@example.org', `${server.url}/?secret=1`, `${server.url}/#fragment`]) {
    failure(await run(server.url, ['topics', '--url', url]), 'INVALID_ARGUMENT');
  }
  assert.equal(server.requests.length, 0);
  assert.deepEqual(JSON.parse(success(await run('https://unused.invalid', ['topics', '--url', server.url]))), { topics: [] });
  assert.equal(server.requests.length, 1);
});

test('Markdown neutralizes service HTML, terminal escapes, and links with unsafe protocols or credentials', async t => {
  const hostile = 'Title ](javascript:bad)\n# injected\u001b[31m <script>alert(1)</script>';
  const server = await service(t, (_request, response) => json(response, digest([
    item('unsafe', { title: hostile, summary: '**injected**\n![img](https://evil.example/track)', url: 'javascript:alert(1)' }),
    item('file', { title: 'Private file', url: 'file:///etc/passwd', published_at: null }),
    item('credentials', { title: 'Credential link', url: 'https://secret:password@example.org/' }),
    item('safe', { title: 'Safe [release]', url: 'https://example.org/a_(b)?q=%3Ctag%3E' }),
  ])));
  const markdown = success(await run(server.url, ['read', '--day', DAY, '--format', 'markdown']));
  assert.doesNotMatch(markdown, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/);
  assert.doesNotMatch(markdown, /<script>|\n# injected/);
  assert.doesNotMatch(markdown, /\]\(<(?:javascript|file):|secret:password/);
  assert.ok(markdown.includes('Safe \\[release\\]'));
  assert.ok(markdown.includes('(<https://example.org/a_(b)?q=%3Ctag%3E>)'));
  assert.match(markdown, /发布: 未知/);
  assert.ok(markdown.includes('\\*\\*injected\\*\\*'));
});

test('insight retains sparse source indexes in JSON and Markdown, and handles missing analysis', async t => {
  const insight = {
    generated_at: TIME, window_start: '2026-09-08T10:00:00Z',
    headline: '综合研判', headline_en: 'Daily analysis', overview: '总体变化', overview_en: 'Overview',
    changes: '新增动向', changes_en: 'New developments', changes_source_indexes: [3, 42, 99],
    wealth: [{ title: '机会', title_en: 'Opportunity', summary: '值得关注', summary_en: 'Worth watching', source_indexes: [42] }],
    employment: [], risks: [], actions: [],
    sources: [
      { index: 3, title: '来源三', title_en: 'Source three', url: 'https://example.org/three', source: 'Publisher A' },
      { index: 42, title: '来源四十二', title_en: 'Source forty-two', url: 'https://example.org/forty-two', source: 'Publisher B' },
    ],
    research_sources: [{ title: 'Research', url: 'https://example.org/research' }],
  };
  let available = true;
  const server = await service(t, (_request, response) => json(response, { insight: available ? insight : null }));
  const data = JSON.parse(success(await run(server.url, ['insight'])));
  assert.deepEqual(data.insight.sources.map(source => source.index), [3, 42]);
  const markdown = success(await run(server.url, ['insight', '--format', 'markdown', '--lang', 'en']));
  assert.match(markdown, /New developments \[3\] \[42\]/);
  assert.match(markdown, /Worth watching \[42\]/);
  assert.ok(markdown.includes('- [42] [Source forty-two](<https://example.org/forty-two>)'));
  assert.doesNotMatch(markdown, /\[99\]|- \[1\]|- \[2\]/);
  assert.ok(markdown.includes('[Research](<https://example.org/research>)'));
  available = false;
  assert.deepEqual(JSON.parse(success(await run(server.url, ['insight']))), { insight: null });
  assert.match(success(await run(server.url, ['insight', '--format', 'markdown'])), /暂无综合研判/);
});
