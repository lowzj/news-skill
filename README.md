# NEWS Skill

在 Codex、Claude Code、OpenCode、Pi 中用自然语言查询 [NEWS](https://xabcnews.com) 已收录的新闻，得到带摘要和来源的简报，并可按需提供原文链接。

```text
用 news 看今天 OpenAI 的重要新闻，给我 5 条，每条附原文链接。
找最近三天 Claude Code 相关的新闻，并说明查询覆盖了哪些日期。
```

项目使用 **TypeScript 开发，编译为 JavaScript 发布**。CLI 默认输出 JSON，方便 Agent 处理；也可输出中文或英文 Markdown 源文本，样式需由客户端渲染。运行需要 Node.js 22.12 或更高版本，无第三方运行时依赖，无需新闻服务账号或额外的 LLM API Key。

## 安装与使用

从 npm 安装 [@lowzj/news-skill](https://www.npmjs.com/package/@lowzj/news-skill)：

```bash
npm install -g @lowzj/news-skill
news skills install --agent codex
```

也可以直接通过 npx 安装 Skill：

```bash
npx --yes --package=@lowzj/news-skill news skills install --agent codex
```

将 `codex` 换成 `claude`、`opencode`、`pi`，或用 `all` 为四个 Agent 安装。默认安装到用户技能目录，跨项目可用；`--scope project` 安装到执行命令时所在的项目。

安装后启动新会话，使用对应入口：

| Agent | 输入示例 |
| --- | --- |
| Codex | `$news 今天 OpenAI 有什么重要新闻？` |
| Claude Code | `/news 今天 OpenAI 有什么重要新闻？` |
| OpenCode | `使用 news skill，查询今天 OpenAI 的重要新闻。` |
| Pi | `/skill:news 今天 OpenAI 有什么重要新闻？` |

Skill 会携带编译后的查询脚本，即使全局 `news` 命令不可用，Agent 仍可通过 Node.js 运行已安装的副本。

终端简报默认使用短列表、来源简称和条目编号，省去展开的长网址；标题与关键数字、结论选择性加粗。若客户端不渲染粗体，则使用 `【重点】` 等短标签和留白。企业案例也使用列表，避免宽表格换行。需要原文时可说“给我第 3 条的链接”或“附上全部原文链接”，完整链接会单独列出；只说“Markdown 输出”仍使用紧凑布局。

完整安装路径、项目安装、更新及本地／GitHub 安装方式见 [安装说明](docs/install.md)。

## 命令行

```bash
# 查看当前可查询的主题及其 ID
news topics

# 查看某个主题已收录的日期
news days --topic openai --limit 7

# 查询今天的新闻，按重要性排序，输出中文 Markdown
news read --topic openai --day today --sort importance --limit 5 --format markdown

# 在已收录内容中搜索一个词组
news search "Claude Code" --from 2026-09-08 --to 2026-09-10 --limit 10

# 获取服务已生成的综合研判
news insight --format markdown

# 查看 Skill 指令与完整命令帮助
news skills show
news --help
```

`--topic` 使用 `news topics` 返回的真实 ID。省略日期时，读取服务最新可用日期；最新可用日期可能早于今天。查“今天”时请明确传入 `--day today`。

常用选项：

| 选项 | 用途 |
| --- | --- |
| `--day YYYY-MM-DD\|today\|yesterday` | 选择一个收录日期 |
| `--days N` | 选择截至今天的连续 N 个自然日，1–31 天 |
| `--from DATE --to DATE` | 指定包含起止日期的范围 |
| `--limit N` | 最多输出 N 条新闻，默认 10 |
| `--sort latest\|importance` | 按时间或重要性排序 |
| `--min-importance 1..5` | 最低重要性 |
| `--max-pages N` | 限制读取的 digest 页数，默认 20 |
| `--format json\|markdown` | 输出格式，默认 JSON |
| `--lang zh\|en` | Markdown 语言，默认中文 |
| `--url URL` | 更换 NEWS API 地址，也可设置 `NEWS_API_URL` |
| `--timeout SECONDS` | 单次请求超时，1–120 秒，默认 20 秒 |

`--day`、`--days`、`--from/--to` 三种日期选择方式互斥；起止日期必须同时提供，最多 31 天。`--limit` 支持 1–100，`--max-pages` 支持 1–200。

详细行为见 [CLI 参考](skills/news/references/cli.md)。

## 查询范围与结果可信度

- 数据来自 NEWS 已收录的内容；本 CLI 通过 `/topics`、`/days`、`/digest`、`/insight` 查询公开数据。它不会触发抓取新话题，也不是全网搜索。
- `search` 在客户端对标题、摘要、来源和标签做大小写不敏感的字面词组匹配，支持中英文与 Unicode NFKC 规范化。它不做语义检索；同义词或不同写法需要分别查询。
- 查询会遍历分页并去重。`coverage.complete` 表示是否已读取本次选定范围内的所有页面。达到 `--max-pages` 上限时，结果会明确标记覆盖不完整；此时零结果不能解释成“没有相关新闻”。
- 日期按服务返回的时区解释，例如 `Asia/Shanghai`。日期筛选对应新闻摘要的收录日期，不保证新闻的实际发布时间都在该区间。
- Agent 根据返回数据组织回答；标题、摘要和研判来自 NEWS，原文链接用于进一步核对。展示方式按客户端适配：终端默认显示简短来源，确认可隐藏链接地址的图形界面可使用 Markdown 标题链接。

## 开发

```bash
npm install
npm run build
npm test
```

TypeScript 提供 API 响应、查询参数和安装逻辑的类型约束；安装包包含编译后的 JavaScript，用户运行时无需 `ts-node`、`tsx` 或 TypeScript 编译器。构建产物同时放入 Skill，使 CLI 与 Agent 使用同一套查询实现。

安装与 Skill 分发方式参考了 [talkoda-cli](https://github.com/lowzj/talkoda-cli)，本项目独立实现。
