# 安装 NEWS CLI 与 Skill

需要 Node.js 22.12+ 和 npm。先用 `node --version` 确认版本。

## 从 npm 安装

安装 [@lowzj/news-skill](https://www.npmjs.com/package/@lowzj/news-skill) 并为 Codex 安装 Skill：

```bash
npm install -g @lowzj/news-skill
news --version
news skills install --agent codex
```

也可以直接通过 npx 安装 Skill：

```bash
npx --yes --package=@lowzj/news-skill news skills install --agent codex
```

通过 npm 安装仅需 Node.js 和 npm，无需 TypeScript 或 Git。通过 npx 安装的 Skill 包含完整 JavaScript 副本，之后不依赖临时 npm 缓存。

## 从当前本地仓库安装

```bash
cd /path/to/news-skill
npm install
npm install -g .
news --help
news skills install --agent codex
```

`npm install` 会安装开发依赖并构建 JavaScript。全局 CLI 的命令名为 `news`，安装包名为 `@lowzj/news-skill`。如果已有同名命令，可以先不做全局安装，直接执行：

```bash
node /absolute/path/to/news-skill/skills/news/scripts/news.js topics
node /absolute/path/to/news-skill/skills/news/scripts/news.js skills install --agent codex
```

以上路径需替换成实际仓库绝对路径。

## 用本地安装包分发

在完成 `npm install` 的仓库中打包，即可在发布前通过 npm / npx 安装或分享：

```bash
npm pack
npx --yes --package=./lowzj-news-skill-0.1.0.tgz news skills install --agent codex
```

版本升级后，将文件名换成 `npm pack` 实际输出的名称。接收安装包的用户仅需 Node.js 和 npm，无需 TypeScript 或 Git。也可执行 `npm install -g ./lowzj-news-skill-0.1.0.tgz` 安装全局 CLI。通过 npx 安装的 Skill 是完整副本，之后不依赖临时 npm 缓存。

## 选择 Agent 和安装范围

```bash
news skills install --agent codex
news skills install --agent claude
news skills install --agent opencode
news skills install --agent pi
```

`--agent all` 安装到四个平台。默认 `--scope user`；希望随项目共享时，在目标项目根目录执行：

```bash
news skills install --agent codex --scope project
```

安装器只写入所选 Skill 目录。默认路径如下：

| Agent | 用户目录 | 项目目录（相对执行目录） |
| --- | --- | --- |
| Codex | `~/.agents/skills/news/` | `.agents/skills/news/` |
| Claude Code | `~/.claude/skills/news/` | `.claude/skills/news/` |
| OpenCode | `~/.config/opencode/skills/news/` | `.opencode/skills/news/` |
| Pi | `~/.pi/agent/skills/news/` | `.pi/skills/news/` |

OpenCode 用户目录遵循 `XDG_CONFIG_HOME`；Pi 用户目录遵循 `PI_CODING_AGENT_DIR`。项目安装相对于当前工作目录，不会自行寻找或更换仓库。Agent 如何发现 Skill 的官方说明：[Codex](https://developers.openai.com/codex/skills)、[Claude Code](https://code.claude.com/docs/en/skills)、[OpenCode](https://opencode.ai/docs/skills/)、[Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)。

安装目录包含 `SKILL.md`、命令参考和运行所需的 JavaScript。安装完成后可直接运行：

```bash
node ~/.agents/skills/news/scripts/news.js topics
```

这条命令以 Codex 默认用户目录为例。它仅需要 Node.js 与网络连接，不依赖全局 CLI、原仓库或临时 npm 缓存。

## 在 Agent 中查询

安装后启动新会话，让 Agent 发现技能：

```text
Codex:       $news 找今天 OpenAI 的 5 条重要新闻，附来源链接。
Claude Code: /news 找今天 OpenAI 的 5 条重要新闻，附来源链接。
OpenCode:    使用 news skill 找今天 OpenAI 的 5 条重要新闻，附来源链接。
Pi:          /skill:news 找今天 OpenAI 的 5 条重要新闻，附来源链接。
```

你也可以直接用自然语言提出新闻查询。Agent 是否自动选用技能受其发现机制和配置影响；显式指定 `news` 更容易验证安装结果。

## 更新已安装的 Skill

通过 npm 更新全局 CLI 后，再更新需要的 Agent 副本：

```bash
npm install -g @lowzj/news-skill@latest
news skills install --agent codex --force
```

如果之前通过 npx 安装，可以直接运行：

```bash
npx --yes --package=@lowzj/news-skill@latest news skills install --agent codex --force
```

从本地仓库安装的用户，先更新仓库并重新安装 CLI，再执行 Skill 更新命令。

相同内容重复安装不会更改文件；已有的 NEWS Skill 内容不同时，需要 `--force` 才会替换。安装器通过 `.news-skill-install.json` 识别自己管理的副本。它会拒绝覆盖未经管理的同名 Skill，即使传了 `--force`。若该目录原本由你手动创建，请先检查内容，并自行改名或移走后重新安装。

`--force` 会替换所选的已管理目录，成功后不保留旧副本；若需要保留自定义修改，请先备份。安装器也会拒绝符号链接目标和与源目录重叠的目标。

## 从 GitHub 分发

以下方式需要先把这份代码推送到 `lowzj/news-skill` 的默认分支，并确保目标用户有仓库读取权限；它们不依赖 npm registry 发布。若代码仍在功能分支，需在仓库地址后追加 `#分支名`，或使用已推送的标签／commit。

安装全局 CLI：

```bash
npm install -g github:lowzj/news-skill
news skills install --agent codex
```

只安装 Skill：

```bash
npx --yes --package=github:lowzj/news-skill news skills install --agent codex
```

GitHub 安装由 npm 的 `prepare` 流程构建 TypeScript，需要 Git 和可用的 npm 网络连接。安装后的 Skill 包含完整 JavaScript 副本，npm 临时缓存清理后仍可运行。

生产分发可固定到已推送的版本标签或 commit，避免默认分支更新影响安装结果。

## 常见问题

**`news` 找不到。** 检查全局 npm 可执行目录是否在 `PATH` 中，或直接用 `node /absolute/path/to/installed/skill/scripts/news.js`。查看安装结果返回的实际目录。

**Agent 没发现技能。** 确认所选 Agent 和 scope 正确，目录内存在 `SKILL.md`，再启动新会话。项目技能需要从对应项目启动 Agent，并满足该客户端的项目信任设置。

**新闻为空或日期旧。** 执行 `news topics` 和 `news days --topic <id>` 检查主题和可用日期。省略日期表示最新可用数据，并不等于今天；明确查询今天请加 `--day today`。

**搜索结果不完整。** 查看 JSON 的 `coverage`，缩小日期或主题范围，或提高 `--max-pages`。调整页数会增加请求量；输出的 `--limit` 只限制展示条数。
