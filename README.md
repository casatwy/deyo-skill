# Deyo 网址

播客和视频转文字稿：[https://deyo.miaobi.fun](https://deyo.miaobi.fun)

# Deyo Skill

[English Version](./README.en.md)

`deyo` 是一个同时面向 **Codex / OpenAI Agents**、**Claude Code**、**OpenClaw** 和 **Gemini CLI** 的 skill，用来指导代理优先通过已安装的 `deyo` 命令行工具完成链接转写或本地音视频文件上传转写，而不是走网页界面。

它覆盖 `deyo` CLI 的安装、API key 鉴权、本地配置优先级、链接/文件命令拼装、AI 可见进度同步、结果格式选择、开发环境 base URL 和常见排查规则。

`deyo/SKILL.md` 复用同一份主说明文件，`agents/` 下的元信息按平台拆分。Claude 当前推荐通过 plugin / marketplace 安装；legacy `~/.claude/skills` 只作为备用安装方式。

## 适用场景

在以下情况下使用这个 skill：

- 用户想安装、配置或升级 `deyo`
- 用户想通过 `deyo` 转写一个受支持链接
- 用户想通过 `deyo` 上传并转写一个本地音视频文件
- 用户想保存一次 API key，避免后续每次重复传参
- 用户想确认 `--api-key`、`DEYO_API_KEY`、`--base-url`、`DEYO_BASE_URL` 或本地配置优先级
- 用户想确认 `--source`、`--file`、`--mime-type`、`--format`、`--progress-format`、`-O`、stdout 输出或 AI 对话里的进度播报行为
- 用户想排查上传、媒体检查、字幕直出、分钟余额或不支持来源分支

## 核心规则

- 优先使用系统里已安装的 `deyo` 命令。
- 如果 `deyo` 不存在，或 `deyo --help` 里还没有 `--progress-format`、`--file`、`--mime-type`，先安装或升级已发布包 `@casatwy/deyo`。
- 默认使用生产服务和 CLI 默认配置；只有用户明确要求本地/开发环境时，才传 `--base-url http://deyo.mac-studio`。
- 不要虚构 API key；如果用户没有提供，要求用户先到 `https://deyo.miaobi.fun/me/api-keys` 创建。
- 用户提供 API key 后，用 `deyo auth login --api-key '...'` 保存到本地，方便后续复用。
- 除非用户明确要求其他结果语言，否则默认追加 `--language zh`。
- 链接转写和本地文件上传转写都需要 API key 鉴权；完整转写任务会扣减账号分钟余额。
- YouTube 如果命中可直接使用的字幕，会直接返回字幕结果，不进入长时间转写，也不扣分钟。
- AI 代跑上传任务或可能持续一段时间的转写任务时，默认追加 `--progress-format jsonl`。
- AI 不要把原始 JSONL 直接贴给用户，而是转述上传百分比、媒体检查、任务创建、状态切换、关键转写百分比和最终结果。
- 如果 `task.created` 表示 `mode: "subtitles"` 或 `resultReady: true`，要明确告诉用户这是“直接命中字幕”，不会进入长时间转写。

## 支持输入

支持 8 类链接来源 + 单个本地音视频文件上传。

链接来源包括：

- `xiaoyuzhou`
- `ximalaya`
- `bilibili`
- `douyin`
- `xiaohongshu`
- `youtube`
- `apple-podcasts`
- `twitter`

本地文件上传规则：

- 支持单个普通音频或视频文件。
- 可用 `deyo ./audio.mp3`、`deyo --file ./audio.mp3`，也可用 `deyo -- ./audio.mp3` 明确把 `--` 后的单个参数当作路径或链接。
- 只有扩展名不明确、自动识别不可靠或需要覆盖媒体类型时才加 `--mime-type`，例如 `audio/mpeg`、`audio/mp4`、`video/mp4`。
- 不支持目录、glob、stdin、批量队列或断点续传。
- 本地文件固定为 `upload` 来源；不要给本地文件传除 `upload` 以外的 `--source`。

## 配置优先级

API key 读取优先级：

1. `--api-key`
2. 环境变量 `DEYO_API_KEY`
3. 本地配置文件，也就是执行 `deyo auth login` 后保存的配置

Base URL 读取优先级：

1. `--base-url`
2. 环境变量 `DEYO_BASE_URL`
3. 本地配置文件中的 `baseUrl`
4. CLI 默认生产地址 `https://deyo.miaobi.fun`

普通使用和生产服务不要显式传 `--base-url`。只有用户明确要求本地/开发环境时，才在登录或运行命令里传：

```bash
deyo auth login --api-key 'deyo_sk_xxx' --base-url http://deyo.mac-studio
deyo --base-url http://deyo.mac-studio --language zh -O ./tmp/out.txt 'https://www.youtube.com/watch?v=xxxx'
```

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
deyo [--api-key <key>] [--source <name>] [--file <path>] [--mime-type <type>] [--language <value>] [--format <value>] [--progress-format <value>] [--base-url <url>] [-O <path>] <url-or-file>
```

## 输出格式

`--format` 支持：

- `text`
- `srt`
- `vtt`
- `json`
- `verbose_json`

如果未传 `-O`，最终转写结果输出到 stdout。如果传了 `-O`，结果写入文件。

如果未传 `--format`，CLI 会根据输出文件后缀自动推断常见格式：

- `.txt -> text`
- `.srt -> srt`
- `.vtt -> vtt`
- `.json -> json`
- 其他情况默认 `text`

如果需要 `verbose_json`，请显式传 `--format verbose_json`。

进度和状态信息写入 stderr，不会混进 stdout 或 `-O` 指定的结果文件。

## AI 纯文本后处理

Skill 保留“纯文本自动加标点和分段”的 agent 行为，但这不是 CLI 内置能力。CLI 返回什么就输出什么；标点和分段只能由 agent 在拿到 `text` 纯文本结果后额外处理。

以下情况不得擅自改写结果：

- 用户要求原始输出或逐字输出。
- 使用 `--format srt`、`--format vtt`、`--format json` 或 `--format verbose_json`。
- 用户要求直接用 `-O` 保存 CLI 原始结果文件。
- 输出内容要用于机器解析、字幕时间轴、JSON 结构或后续自动化流程。

## 进度格式与事件

`--progress-format` 支持：

- `auto`
- `text`
- `jsonl`

`auto` 是默认值：

- 当 stderr 是 TTY 时，保留单行原地刷新体验。
- 当 stderr 不是 TTY 时，退化成逐行文本进度，避免控制字符污染日志或代理输出。

`--progress-format jsonl` 会在 stderr 上输出一行一个 JSON 事件，适合 AI 稳定读取并转述。

本地上传事件：

- `upload.hashing`
- `upload.started`
- `upload.progress`
- `upload.completed`
- `upload.checking`
- `upload.ready`
- `upload.aborted`
- `upload.failed`

转写任务事件：

- `task.created`
- `task.status_changed`
- `task.progress`
- `task.completed`
- `task.failed`
- `task.cancelled`
- `task.result_written`
- `task.notice`

本地上传事件不会包含签名 URL、文件 hash 或分片 ETag。任务和结果 JSON 中的上传来源会脱敏为 `upload:file`。

## 推荐工作流

1. 先确认机器上是否已安装 `deyo`。
2. 先用 `deyo --help` 确认本机 CLI 已支持 `--progress-format`、`--file`、`--mime-type`、`json` 和 `verbose_json`。
3. 确认目标是链接还是本地文件，以及输出格式和输出路径。
4. 如果本地尚未登录，向用户索取 API key 并执行 `deyo auth login --api-key '...'`。
5. 仅在用户明确要求本地/开发环境时追加 `--base-url http://deyo.mac-studio`。
6. 除非用户明确指定其他语言，否则追加 `--language zh`。
7. 仅在强制指定平台有帮助时才加 `--source`；本地文件不要传非 `upload` 的 `--source`。
8. 本地文件任务可使用位置参数或 `--file`；仅在需要时加 `--mime-type`。
9. AI 代跑上传或长任务时追加 `--progress-format jsonl`。
10. 运行最终命令，并把上传百分比、媒体检查、任务创建、状态切换、关键转写百分比与最终结果同步给用户。
11. 只有在拿到 plain text 且用户没有要求原始输出时，agent 才可以额外加标点和分段。

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

导出 VTT：

```bash
deyo --language zh --format vtt -O ./tmp/out.vtt 'https://www.youtube.com/watch?v=xxxx'
```

直接从 stdout 读取 JSON：

```bash
deyo --language zh --format json 'https://www.bilibili.com/video/BVxxxx'
```

读取更完整的 JSON：

```bash
deyo --language zh --format verbose_json 'https://www.bilibili.com/video/BVxxxx'
```

使用临时 API key：

```bash
deyo --api-key 'deyo_sk_other' --language zh 'https://www.bilibili.com/video/BVxxxx'
```

明确使用开发环境：

```bash
deyo --base-url http://deyo.mac-studio --language zh -O ./tmp/dev.txt 'https://www.youtube.com/watch?v=xxxx'
```

处理喜马拉雅单集：

```bash
deyo --language zh -O ./tmp/ximalaya.txt 'https://www.ximalaya.com/sound/963656969'
```

强制使用 Twitter/X 源：

```bash
deyo --language zh --source twitter -O ./tmp/tweet.txt 'https://x.com/historyinmemes/status/1790637656616943991'
```

B 站 player 嵌入链接必须带 `bvid`：

```bash
deyo --language zh -O ./tmp/bilibili.txt 'https://player.bilibili.com/player.html?bvid=BVxxxx&page=2&cid=123456'
```

B 站 App 分享视频链接可以直接传入；CLI 会提交原始 App URL，由 Whisper 解析 `h5awaken.open_app_url`、`h5awaken` base64 中的 `open_app_url` 或路径本身的 BV 号：

```bash
deyo --language zh -O ./tmp/bilibili-app.txt 'bilibili://video/BVxxxx?page=2'
```

## 来源边界

- 喜马拉雅当前支持单集页和 `xima.tv` 短链；合集链接会返回 422，提示选择具体单集，不扣分钟、不创建转写任务。
- 小红书图文笔记会返回不支持分支，不继续转写。
- 抖音图文内容会返回不支持分支，不继续转写。
- Twitter/X 只有视频推文可转写；文本 / 图片推文会返回 422，不扣分钟、不创建转写任务。
- YouTube 如果命中可直接使用的字幕，会直接输出 TXT / SRT / VTT / JSON 结果，不扣分钟。
- B 站支持普通 BV 页面、`b23.tv` 短链、带合法 `bvid` 的 `player.bilibili.com/player.html` 嵌入播放器链接，以及能由 Whisper 解出 BV 页面的 `bilibili://video/...` App 分享视频链接；CLI 只识别并透传原始 App 链接，不在本地解码或推导 BV；player 链接中 `p` 优先、`page` 兜底，`cid` 会被忽略，只有 `aid/cid` 的 player 链接不支持；`bilibili://space/...` 等非 video App 链接不支持。

## 故障排查

- `deyo: command not found`：先安装 `@casatwy/deyo`。
- `缺少 API key。请传 --api-key、设置 DEYO_API_KEY，或先执行 deyo auth login`：让用户先在 `/me/api-keys` 创建 key，再执行 `deyo auth login`，或临时传 `--api-key` / `DEYO_API_KEY`。
- `API key 无效或不存在`：要求用户重新生成有效 key。
- `剩余分钟不足`：当前账号分钟余额不足，需要先充值分钟包。
- 目录、glob、stdin、批量文件或断点续传请求不支持：请用户改为提供一个具体的本地音频或视频文件路径。
- `--mime-type` 只能用于本地文件，且只支持 `audio/*` 或 `video/*`。
- 无法识别本地文件 MIME：使用 `--mime-type audio/*` 或 `--mime-type video/*` 明确指定。
- 本地文件为空、不是普通文件或没有可转写音频轨：请用户换一个普通音频或视频文件。
- 媒体检查失败、无音轨、无法读取时长或 ffprobe 失败：请用户换文件或先本地确认媒体可播放且包含音轨。
- 上传分片遇到 403：通常是签名过期或上传签名异常；CLI 会重签并重试，仍失败时保留原始错误。
- 上传后的文件 SHA-256 校验失败：重新选择文件再上传。
- 任务创建后中断本地 CLI，不等于取消服务端任务；CLI 会提示“服务端转写仍在继续”或“服务端正在处理上传”。
- 如果用户反馈没有进度更新，先确认 `deyo --help` 是否已经包含 `--progress-format`；如果没有，先升级 CLI。
- 如果中途丢失实时进度，留意 CLI 是否输出了“事件流中断，回退到轮询状态”的提示。
- 如果任务创建后很快结束，优先判断是否是直接返回字幕的场景，而不是长时间转写链路。
- 如果 B 站 player 链接只有 `aid` 或 `cid`，请用户提供普通 BV 页面 URL，或提供带 `bvid` 的 player 链接；如果是只有纯数字 aid 且 Whisper 无法解出 BV 页面的 `bilibili://video/...` App 链接，也请用户改用普通 BV 页面 URL。
- 如果 Twitter/X 链接返回“推文没有视频”，明确告诉用户当前只能转写视频推文，文本 / 图片推文只会展示基础信息。

## 在 Claude Code 中使用

Claude 当前主路径是通过 Deyo 官方 marketplace 安装 plugin：

```bash
npm install -g @casatwy/deyo

claude plugin marketplace add https://deyo.miaobi.fun/ai/install/claude/marketplace.json

claude plugin install deyo@deyo-official
```

如果 `claude plugin install` 失败，请保留原始错误，不要自行修改全局 git / SSH / npm 配置，也不要手动绕行下载。

Claude plugin cache 检查只适用于通过 `claude plugin install` 安装 plugin 的场景。此时可以检查 Claude Code 的 plugin 缓存目录，例如 `~/.claude/plugins/` 或当前 Claude Code 使用的 plugin 目录。

Legacy 备用方式：如果当前环境不能使用 Claude plugin / marketplace，可以把 `deyo/` 目录复制或软链到 Claude skills 目录。

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

Legacy skills 安装不适用 plugin cache 检查；只需确认目标 `SKILL.md` 可被 Claude Code 读取。

安装完成后，Claude Code 会在匹配场景中自动建议调用，也可以显式触发：

```text
/deyo 帮我把这个 YouTube 链接转成中文 SRT
```

Claude 侧的元信息记录在 `deyo/agents/claude.yaml`。Claude plugin 元信息记录在仓库根部的 `.claude-plugin/plugin.json`。

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

Gemini CLI 原生支持读取带 frontmatter 的 `SKILL.md`。可以通过以下命令安装：

用户级（全机可用）：

```bash
gemini skills install "$(pwd)/deyo" --scope user
```

项目级（只在当前仓库可用）：

```bash
gemini skills install "$(realpath ./deyo)" --scope workspace
```

安装后，在 Gemini CLI 交互会话中执行 `/skills reload` 生效。额外说明记录在 `deyo/agents/gemini.yaml`。

## 目录结构

```text
skill_/
├── README.md
├── README.en.md
├── .claude-plugin/
│   └── plugin.json
└── deyo/
    ├── SKILL.md
    └── agents/
        ├── openai.yaml
        ├── claude.yaml
        └── gemini.yaml
```

## 相关文件

- `deyo/SKILL.md`：skill 的主说明文件，定义适用场景、规则和示例。
- `deyo/agents/openai.yaml`：Codex / OpenAI Agents 元信息。
- `deyo/agents/claude.yaml`：Claude Code 侧显示名、触发方式与 legacy skill 说明。
- `deyo/agents/gemini.yaml`：Gemini CLI 安装和集成说明。
- `.claude-plugin/plugin.json`：Claude plugin / marketplace 元信息。
