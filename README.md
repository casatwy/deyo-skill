# Deyo Skill

[English Version](./README.en.md)

`deyo` 是一个同时面向 **Codex / OpenAI Agents**、**Claude Code** 和 **OpenClaw** 的 skill，用来指导代理优先通过已安装的 `deyo` 命令行工具完成链接转写或本地音视频文件上传转写，而不是走网页界面。

它覆盖了 `deyo` CLI 的安装、一次性 API key 登录、本地配置检查、链接/文件转写命令拼装、AI 可见进度同步，以及常见故障处理规则。

`deyo/SKILL.md` 复用同一份主说明文件，同时兼容 Codex / OpenAI Agents、Claude Code 和 OpenClaw 所使用的 skill 规范，仅 `agents/` 下的元信息按平台拆分。

## 适用场景

在以下情况下使用这个 skill：

- 用户想安装或配置 `deyo`
- 用户想通过 `deyo` 转写一个链接
- 用户想通过 `deyo` 上传并转写一个本地音视频文件
- 用户想保存一次 API key，避免后续每次重复传参
- 用户想确认 `--source`、`--file`、`--mime-type`、`--format`、`-O`、stdout 输出、CLI 进度或 AI 对话里的进度播报行为

## 核心规则

- 优先使用系统里已安装的 `deyo` 命令
- 如果 `deyo` 不存在，或 `deyo --help` 里还没有 `--progress-format`、`--file`、`--mime-type`，先安装或升级已发布包 `@casatwy/deyo`
- 生产环境默认使用 CLI 自带的服务地址 `https://deyo.miaobi.fun`
- 只有用户明确要求本地开发环境时，才传 `--base-url http://deyo.mac-studio`
- 不要虚构 API key；如果用户没有提供，要求用户先到 `/me/api-keys` 创建
- 用户提供 API key 后，用 `deyo auth login --api-key '...'` 保存到本地，方便后续复用
- 除非用户明确要求其他结果语言，否则默认追加 `--language zh`
- 支持输入是 8 类链接来源 + 单个本地音视频文件上传
- 支持链接来源包括 `xiaoyuzhou`、`ximalaya`、`bilibili`、`douyin`、`xiaohongshu`、`youtube`、`apple-podcasts`、`twitter`
- 本地文件可用 `deyo ./audio.mp3` 或 `deyo --file ./audio.mp3`；只有需要覆盖或明确媒体类型时才加 `--mime-type`
- 不支持目录、glob、stdin、批量队列或断点续传；用户必须提供一个具体的本地音频或视频文件
- `ximalaya` 支持喜马拉雅单集页和 `xima.tv` 短链；合集链接不会转写，会返回 422 并提示选择具体单集链接
- `bilibili` 支持普通 BV 页面、`b23.tv` 短链、带合法 `bvid` 的 `player.bilibili.com/player.html` 嵌入播放器链接，以及能由 Whisper 通过 `h5awaken.open_app_url`、`h5awaken` base64 或路径 BV 号解出标准 BV 页面的 `bilibili://video/...` App 分享视频链接；CLI 只识别并透传原始 App 链接，不在本地解码或推导 BV；player 链接中 `p` 优先、`page` 兜底，`cid` 会被忽略，只有 `aid/cid` 的 player 链接不支持；`bilibili://space/...` 等非 video App 链接不支持
- Twitter/X 只有视频推文可转写；文本 / 图片推文会返回 422，不会扣分钟或创建转写任务
- 链接转写和本地文件上传转写都需要 API key 鉴权；完整转写任务会扣减账号分钟余额
- 只要是 AI 代跑上传任务，或 AI 代跑且可能持续一段时间的转写任务，默认追加 `--progress-format jsonl`
- AI 不要把原始 JSONL 直接贴给用户，而是要把上传百分比、媒体检查、任务创建、状态切换、关键转写百分比和最终结果转述给用户
- 如果 `task.created` 表示 `mode: subtitles` 或 `resultReady: true`，要明确告诉用户这是“直接命中字幕”，不会进入长时间转写

## 命令速查

安装 CLI：

```bash
npm install -g @casatwy/deyo
```

保存 API key：

```bash
deyo auth login --api-key 'deyo_sk_xxx'
```

检查本地登录状态：

```bash
deyo auth status
```

清除本地登录状态：

```bash
deyo auth logout
```

执行转写：

```bash
deyo [--source <name>] [--file <path>] [--mime-type <type>] [--language <value>] [--format <value>] [--progress-format <value>] [-O <path>] <url-or-file>
```

## 输出规则

- 如果未传 `-O`，最终转写结果输出到 stdout
- 如果未传 `--format`，CLI 会根据输出文件后缀自动推断格式
- `.txt -> text`
- `.srt -> srt`
- `.vtt -> vtt`
- `.json -> json`
- 进度和状态信息写入 stderr
- 本地文件任务的进度包括上传百分比、媒体检查、任务创建、转写进度和最终状态
- `--progress-format auto` 是默认值
- 当 stderr 是 TTY 时，`auto` 会保留当前的单行原地刷新体验
- 当 stderr 不是 TTY 时，`auto` 会退化成逐行文本进度，避免输出控制字符污染日志或代理输出
- `--progress-format jsonl` 会在 stderr 上输出一行一个 JSON 事件，适合 AI 读取并向用户转述

## 推荐工作流

1. 先确认机器上是否已安装 `deyo`
2. 先用 `deyo --help` 确认本机 CLI 已支持 `--progress-format`、`--file`、`--mime-type`
3. 确认目标是链接还是本地文件，以及输出格式和输出路径
4. 如果本地尚未登录，向用户索取 API key 并执行 `deyo auth login`
5. 仅在需要时区分生产环境或本地开发环境
6. 除非用户明确指定其他语言，否则追加 `--language zh`
7. 仅在强制指定平台有帮助时才加 `--source`
8. 本地文件任务可使用位置参数或 `--file`；仅在需要时加 `--mime-type`
9. AI 代跑上传或长任务时追加 `--progress-format jsonl`
10. 运行最终命令，并把上传百分比、媒体检查、任务创建、状态切换、关键转写百分比与最终结果同步给用户

## 示例

安装已发布的 CLI：

```bash
npm install -g @casatwy/deyo
```

保存 API key：

```bash
deyo auth login --api-key 'deyo_sk_xxx'
```

输出中文文本文件：

```bash
deyo --language zh -O ./tmp/transcript.txt 'https://www.youtube.com/watch?v=xxxx'
```

AI 友好的结构化进度模式：

```bash
deyo --language zh --progress-format jsonl -O ./tmp/transcript.txt 'https://www.youtube.com/watch?v=xxxx'
```

转写本地文件：

```bash
deyo --language zh -O ./tmp/audio.txt ./audio.mp3
```

显式指定本地文件和 MIME type：

```bash
deyo --language zh --progress-format jsonl --file ./audio.mp3 --mime-type audio/mpeg -O ./tmp/audio.txt
```

强制使用 YouTube 源并导出 SRT：

```bash
deyo --language zh --source youtube --format srt -O ./tmp/out.srt 'https://youtu.be/xxxx'
```

强制使用 Twitter/X 源：

```bash
deyo --language zh --source twitter -O ./tmp/tweet.txt 'https://x.com/historyinmemes/status/1790637656616943991'
```

直接从 stdout 读取 JSON：

```bash
deyo --language zh --format json 'https://www.bilibili.com/video/BVxxxx'
```

B站 player 嵌入链接必须带 `bvid`：

```bash
deyo --language zh -O ./tmp/bilibili.txt 'https://player.bilibili.com/player.html?bvid=BVxxxx&page=2&cid=123456'
```

B站 App 分享视频链接可以直接传入；CLI 会提交原始 App URL，由 Whisper 解析 `h5awaken.open_app_url`、`h5awaken` base64 中的 `open_app_url` 或路径本身的 BV 号：

```bash
deyo --language zh -O ./tmp/bilibili-app.txt 'bilibili://video/BVxxxx?page=2'
```

## 故障排查

- `deyo: command not found`：先安装 `@casatwy/deyo`
- `缺少 API key。请传 --api-key、设置 DEYO_API_KEY，或先执行 deyo auth login`：让用户先在 `/me/api-keys` 创建 key，再执行 `deyo auth login`
- `API key 无效或不存在`：要求用户重新生成有效 key
- `剩余分钟不足`：当前账号分钟余额不足
- 目录、glob、stdin、批量文件或断点续传请求不支持：请用户改为提供一个具体的本地音频或视频文件路径
- 如果用户反馈没有进度更新，先确认 `deyo --help` 是否已经包含 `--progress-format`；如果没有，先升级 CLI
- 如果任务创建后很快结束，优先判断是否是直接返回字幕的场景，而不是长时间转写链路
- 如果 B站 player 链接只有 `aid` 或 `cid`，请用户提供普通 BV 页面 URL，或提供带 `bvid` 的 player 链接；如果是只有纯数字 aid 且 Whisper 无法解出 BV 页面的 `bilibili://video/...` App 链接，也请用户改用普通 BV 页面 URL
- 如果 Twitter/X 链接返回“推文没有视频”，明确告诉用户当前只能转写视频推文，文本 / 图片推文只会展示基础信息
- 如果中途丢失实时进度，留意 CLI 是否输出了“事件流中断，回退到轮询状态”的提示

## 在 Claude Code 中使用

Claude Code 会从 `~/.claude/skills/<name>/SKILL.md` 加载 skill，本仓库的 `deyo/SKILL.md` 已符合该规范，安装方式有两种：

用户级（全机可用）：

```bash
mkdir -p ~/.claude/skills
ln -snf "$(pwd)/deyo" ~/.claude/skills/deyo
```

项目级（只在当前仓库可用）：

```bash
mkdir -p .claude/skills
ln -snf "$(realpath ./deyo)" .claude/skills/deyo
```

安装完成后，Claude Code 会在匹配场景中自动建议调用，也可以显式触发：

```text
/deyo 帮我把这个 YouTube 链接转成中文 SRT
```

Claude 侧的元信息（display name、默认提示词等）记录在 `deyo/agents/claude.yaml`，与 `openai.yaml` 平行，互不影响。

## 在 Codex / OpenAI Agents 中使用

参考 `deyo/agents/openai.yaml`，按 Codex / OpenAI Agents 的 skill 注册流程加载 `deyo/SKILL.md` 即可。

## 在 OpenClaw / ClawHub 中使用

如果你已经在使用 OpenClaw，推荐优先用它自带的 `openclaw skills` 命令从 ClawHub 安装 `deyo`。ClawHub 是 OpenClaw 的公开 skill 注册表；如果你只想单独搜索或备用安装，也可以直接使用 `clawhub` CLI。

先确保机器上已经有 `deyo` 命令：

```bash
npm install -g @casatwy/deyo
```

推荐方式：在当前 workspace 安装 skill：

```bash
openclaw skills search "deyo"
openclaw skills install deyo
```

安装后，执行一次 API key 登录：

```bash
deyo auth login --api-key 'deyo_sk_xxx'
```

后续更新所有已安装 skills：

```bash
openclaw skills update --all
```

如果你更偏向单独使用 ClawHub CLI，也可以这样做：

```bash
npm install -g clawhub

clawhub search "deyo"
clawhub install deyo
```

安装完成后，就可以在 OpenClaw 对话里直接提需求，例如：

```text
用 deyo 把这个 YouTube 链接转成中文 SRT
```

## 在 Gemini CLI 中使用

Gemini CLI 原生支持读取包含 frontmatter 的 `SKILL.md`。可以通过以下命令安装：

用户级（全机可用）：

```bash
gemini skills install "$(pwd)/deyo" --scope user
```

项目级（只在当前仓库可用）：

```bash
gemini skills install "$(realpath ./deyo)" --scope workspace
```

安装后，请在 Gemini 交互式会话中执行 `/skills reload` 使其生效。相关说明记录在 `deyo/agents/gemini.yaml`。

## 目录结构

```text
skill_/
├── README.md
├── README.en.md
└── deyo/
    ├── SKILL.md
    └── agents/
        ├── openai.yaml
        ├── claude.yaml
        └── gemini.yaml
```

## 相关文件

- `deyo/SKILL.md`：skill 的主说明文件，定义适用场景、规则和示例（同时兼容 Codex、Claude Code、OpenClaw 与 Gemini CLI）
- `deyo/agents/openai.yaml`：OpenAI Agents 侧的显示名、简述和默认提示词配置
- `deyo/agents/claude.yaml`：Claude Code 侧的显示名、安装路径与触发方式说明
- `deyo/agents/gemini.yaml`：Gemini CLI 侧的安装说明及相关元信息说明
