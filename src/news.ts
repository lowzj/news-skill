#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { NewsClient, NewsError } from './client.js';
import { formatDays, formatInsight, formatNews, formatTopics, type Language } from './format.js';
import { VERSION } from './meta.js';
import { queryNews } from './query.js';
import { installSkills, readSkill } from './skills.js';
import type { SelectionOptions } from './types.js';

const HELP = `NEWS — public news in your agent (Node.js 22.12+)

Usage:
  news topics
  news days [--topic ID] [--limit N]
  news read [selection options]
  news search "KEYWORDS" [selection options]
  news insight
  news skills show
  news skills install --agent codex|claude|opencode|pi|all
                      [--scope user|project] [--force]

Selection options:
  --topic ID             One public topic ID (discover with news topics)
  --day DATE             YYYY-MM-DD, today, or yesterday
  --days N               Last N calendar days including today (1–31)
  --from DATE --to DATE  Inclusive collection-date range (at most 31 days)
                        Use one date selector; default: latest available day
  --limit N              Global output limit (default 10, max 100)
  --sort latest|importance   Default: latest
  --min-importance N     Minimum importance, 1–5 (default 1)
  --max-pages N          Total digest scan requests (default 20, max 200)

Common options:
  --format json|markdown  Default: JSON; Markdown source needs a renderer
  --lang zh|en            Markdown language (default zh)
  --url URL              API base URL (or NEWS_API_URL)
  --timeout SECONDS      Per-request timeout (default 20, max 120)
  -h, --help             Show this help
  -v, --version          Show version

Examples:
  news read --topic openai --day today --limit 5 --format markdown
  news search "Claude Code" --days 3 --format markdown
  news read --topic github --sort importance --lang en --format markdown

Search matches a literal phrase in existing bilingual titles, summaries,
sources and tags. It does not request fresh crawling or web search.
Dates select collection days in the API timezone. Incomplete scans are
marked in coverage.complete; no matches need not mean no news exists.

Skills are copied with the CLI included. Reload skills or start a new
agent session after installation. Existing unrelated skills are preserved.
`;

const definition = {
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  topic: { type: 'string' }, day: { type: 'string' }, days: { type: 'string' },
  from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'string' },
  sort: { type: 'string' }, 'min-importance': { type: 'string' }, 'max-pages': { type: 'string' },
  format: { type: 'string' }, lang: { type: 'string' }, url: { type: 'string' }, timeout: { type: 'string' },
  agent: { type: 'string' }, scope: { type: 'string' }, force: { type: 'boolean' },
} as const;

function number(value: string | undefined, option: string, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) {
    throw new NewsError('INVALID_ARGUMENT', `--${option} must be an integer from 1 to ${max}`);
  }
  return Number(value);
}

function print(data: unknown, markdown: () => string, format: string): void {
  process.stdout.write(`${format === 'markdown' ? markdown() : JSON.stringify(data, null, 2)}\n`);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let parsed;
  try { parsed = parseArgs({ args, options: definition, allowPositionals: true, tokens: true }); }
  catch (error) { throw new NewsError('INVALID_ARGUMENT', error instanceof Error ? error.message : 'Invalid arguments'); }
  const { values, positionals, tokens } = parsed;
  if (values.help || args.length === 0) { process.stdout.write(HELP); return; }
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new NewsError('INVALID_ARGUMENT', `--${token.name} must only be provided once`);
    seen.add(token.name);
  }
  const [command, ...rest] = positionals;
  const format = values.format ?? 'json';
  if (!['json', 'markdown'].includes(format)) throw new NewsError('INVALID_ARGUMENT', '--format must be json or markdown');
  const lang = values.lang ?? 'zh';
  if (!['zh', 'en'].includes(lang)) throw new NewsError('INVALID_ARGUMENT', '--lang must be zh or en');
  const language = lang as Language;
  const common = ['help', 'version', 'format', 'lang', 'url', 'timeout'];
  const selectionFlags = ['topic', 'day', 'days', 'from', 'to', 'limit', 'sort', 'min-importance', 'max-pages'];
  const allowed: Record<string, string[]> = {
    topics: [], days: ['topic', 'limit'], read: selectionFlags, search: selectionFlags,
    insight: [], skills: rest[0] === 'install' ? ['agent', 'scope', 'force'] : [],
  };
  if (!command || !(command in allowed)) throw new NewsError('INVALID_ARGUMENT', `Unknown command: ${command ?? '(missing)'}. Run news --help.`);
  for (const flag of seen) {
    if (!common.includes(flag) && !allowed[command]!.includes(flag)) throw new NewsError('INVALID_ARGUMENT', `--${flag} is not supported by ${command}`);
  }
  if (command === 'skills') {
    if (rest.length !== 1) throw new NewsError('INVALID_ARGUMENT', 'Use news skills show or news skills install --agent AGENT');
    if (rest[0] === 'show') { process.stdout.write(await readSkill()); return; }
    if (rest[0] !== 'install') throw new NewsError('INVALID_ARGUMENT', 'Unknown skills command');
    if (!values.agent) throw new NewsError('INVALID_ARGUMENT', 'Specify --agent codex|claude|opencode|pi|all');
    const result = await installSkills({ agent: values.agent, scope: values.scope, force: values.force });
    print(result, () => result.installations.map((item) => `- ${item.agent}: ${item.status} — ${item.path}`).join('\n'), format);
    return;
  }
  if (command === 'search' ? rest.length !== 1 || !rest[0]?.trim() : rest.length !== 0) {
    throw new NewsError('INVALID_ARGUMENT', command === 'search' ? 'Supply one quoted search phrase: news search "Claude Code"' : `${command} does not accept positional arguments`);
  }
  if (values.topic !== undefined && !values.topic.trim()) throw new NewsError('INVALID_ARGUMENT', '--topic must not be empty');
  const timeout = number(values.timeout, 'timeout', 120) ?? 20;
  const client = new NewsClient({ url: values.url, timeoutMs: timeout * 1000 });
  if (command === 'topics') {
    const result = await client.topics();
    print(result, () => formatTopics(result, language), format);
  } else if (command === 'days') {
    const result = await client.days(values.topic, number(values.limit, 'limit', 366) ?? 30);
    print(result, () => formatDays(result, language), format);
  } else if (command === 'insight') {
    const result = await client.insight();
    print(result, () => formatInsight(result, language), format);
  } else {
    if (values.sort && !['latest', 'importance'].includes(values.sort)) throw new NewsError('INVALID_ARGUMENT', '--sort must be latest or importance');
    const options: SelectionOptions = {
      topic: values.topic, day: values.day, days: number(values.days, 'days', 31), from: values.from, to: values.to,
      limit: number(values.limit, 'limit', 100), sort: values.sort as SelectionOptions['sort'],
      minImportance: number(values['min-importance'], 'min-importance', 5), maxPages: number(values['max-pages'], 'max-pages', 200),
      ...(command === 'search' ? { query: rest[0]! } : {}),
    };
    const result = await queryNews(client, options);
    print(result, () => formatNews(result, language), format);
  }
}

// Pipe consumers such as head may close stdout early. That is a successful read.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

main().catch((error: unknown) => {
  const code = error instanceof NewsError ? error.code : 'COMMAND_FAILED';
  const message = error instanceof Error ? error.message : 'NEWS command failed';
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exitCode = 1;
});
