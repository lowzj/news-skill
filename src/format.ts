import type { DaysResponse, QueryResult, TopicsResponse } from './types.js';
import type { InsightDocument, InsightResponse } from './client.js';

export type Language = 'zh' | 'en';

/** Render service text as text, not HTML, terminal escapes, or new Markdown blocks. */
export function escapeMarkdown(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/[\\`*_[\]<>#|]/g, '\\$&');
}

function link(title: string, url: string): string {
  const label = escapeMarkdown(title);
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return label;
    const href = parsed.href.replace(/[<>\\]/g, (char) => encodeURIComponent(char));
    return `[${label}](<${href}>)`;
  } catch {
    return label;
  }
}

function localized(row: { [key: string]: unknown }, key: string, lang: Language): string {
  const english = row[`${key}_en`];
  const native = row[key];
  return lang === 'en' && typeof english === 'string' && english.trim()
    ? english : typeof native === 'string' ? native : '';
}

function timestamp(value: string, timezone: string): string {
  const formatted = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
  return `${formatted} (${timezone})`;
}

export function formatTopics(data: TopicsResponse, lang: Language): string {
  const lines = [lang === 'zh' ? '# NEWS 主题' : '# NEWS topics', ''];
  for (const topic of data.topics) {
    lines.push(`- **${escapeMarkdown(lang === 'en' ? topic.name_en || topic.name : topic.name)}** — \`${escapeMarkdown(topic.id)}\``);
    if (topic.description) lines.push(`  ${escapeMarkdown(topic.description)}`);
    lines.push(`  ${lang === 'zh' ? '最近收录日期' : 'Latest collection day'}: ${topic.latest_day ?? '—'}`);
  }
  if (!data.topics.length) lines.push(lang === 'zh' ? '暂无公开主题。' : 'No public topics available.');
  return lines.join('\n');
}

export function formatDays(data: DaysResponse, lang: Language): string {
  return [lang === 'zh' ? '# NEWS 收录日期' : '# NEWS collection days', '',
    ...data.days.map((day) => `- ${day.day}: ${day.count} ${lang === 'zh' ? '条' : 'items'}`),
    ...(!data.days.length ? [lang === 'zh' ? '暂无收录。' : 'No archived items.'] : []),
  ].join('\n');
}

export function formatNews(data: QueryResult, lang: Language): string {
  const en = lang === 'en';
  const dates = data.coverage.days;
  const range = dates.length > 1 ? `${dates.at(-1)} – ${dates[0]}` : dates[0] ?? (en ? 'No collection date' : '暂无收录日期');
  const lines = [data.query ? `# NEWS · ${escapeMarkdown(data.query)}` : '# NEWS', '',
    `${en ? 'Collection dates' : '收录日期'}: ${range} · ${escapeMarkdown(data.timezone)}`,
    `${en ? 'Retrieved' : '查询时间'}: ${timestamp(data.retrieved_at, data.timezone)}`,
    `${en ? 'Returned / matched in scanned content' : '返回 / 已扫描内容中的匹配数'}: ${data.returned} / ${data.matched}`, ''];
  if (!data.coverage.complete) {
    lines.push(en
      ? `> Partial results: reached the ${data.coverage.max_pages}-page scan limit. More matches may exist. Increase --max-pages or narrow the selection.`
      : `> 结果不完整：已达到 ${data.coverage.max_pages} 页扫描上限，可能还有匹配新闻。可增加 --max-pages 或缩小查询范围。`, '');
  }
  if (!data.items.length) lines.push(en ? 'No matches in the scanned NEWS content.' : '已扫描的 NEWS 内容中没有匹配项。', '');
  for (const [index, item] of data.items.entries()) {
    const title = en ? item.title_en || item.title : item.title;
    const summary = en ? item.summary_en || item.summary : item.summary;
    lines.push(`${index + 1}. **${link(title, item.url)}**`, `   ${escapeMarkdown(summary)}`);
    const when = item.published_at ? timestamp(item.published_at, data.timezone) : (en ? 'Unknown' : '未知');
    lines.push(`   ${escapeMarkdown(item.source)} · ${en ? 'Published' : '发布'}: ${when} · ${en ? 'Importance' : '重要性'}: ${item.importance}/5`);
    lines.push(`   ${en ? 'Collected' : '收录'}: ${timestamp(item.first_seen_at, data.timezone)} · ${item.topic_ids.map(escapeMarkdown).join(', ')}`, '');
  }
  if (data.sources.length) {
    const updates = new Map<string, string>();
    for (const source of data.sources) {
      if (source.updated_at && source.updated_at > (updates.get(source.topic_id) ?? '')) updates.set(source.topic_id, source.updated_at);
    }
    if (updates.size) {
      lines.push(en ? 'Source snapshot updates (within the selected dates):' : '来源快照更新时间（所选日期内）：');
      for (const [topic, updatedAt] of updates) lines.push(`- ${escapeMarkdown(topic)}: ${timestamp(updatedAt, data.timezone)}`);
    }
  }
  return lines.join('\n');
}

function references(indexes: number[], insight: InsightDocument): string {
  return indexes.filter((index) => insight.sources.some((source) => source.index === index)).map((index) => `[${index}]`).join(' ');
}

export function formatInsight(data: InsightResponse, lang: Language): string {
  const en = lang === 'en';
  const insight = data.insight;
  if (!insight) return en ? 'No NEWS analysis is available yet.' : 'NEWS 暂无综合研判。';
  const lines = [`# ${escapeMarkdown(localized(insight, 'headline', lang))}`, '',
    `${en ? 'NEWS AI analysis · Generated' : 'NEWS AI 综合研判 · 生成时间'}: ${escapeMarkdown(insight.generated_at)}`,
    `${en ? 'Analysis window starts' : '分析窗口起点'}: ${escapeMarkdown(insight.window_start)}`, '',
    escapeMarkdown(localized(insight, 'overview', lang)), '',
    `${escapeMarkdown(localized(insight, 'changes', lang))} ${references(insight.changes_source_indexes, insight)}`, ''];
  const sections = [['wealth', '商业与机遇', 'Business and opportunities'], ['employment', '就业与技能', 'Employment and skills'],
    ['risks', '风险预警', 'Risks'], ['actions', '观察方向', 'What to watch']] as const;
  for (const [key, chinese, english] of sections) {
    if (!insight[key].length) continue;
    lines.push(`## ${en ? english : chinese}`, '');
    for (const signal of insight[key]) {
      lines.push(`- **${escapeMarkdown(localized(signal, 'title', lang))}** — ${escapeMarkdown(localized(signal, 'summary', lang))} ${references(signal.source_indexes, insight)}`);
    }
    lines.push('');
  }
  if (insight.sources.length || insight.research_sources.length) {
    lines.push(en ? '## Sources' : '## 来源', '');
    for (const source of insight.sources) {
      lines.push(`- [${source.index}] ${link(localized(source, 'title', lang), source.url)} — ${escapeMarkdown(source.source)}`);
    }
    for (const source of insight.research_sources) lines.push(`- ${link(source.title, source.url)}`);
  }
  return lines.join('\n');
}
