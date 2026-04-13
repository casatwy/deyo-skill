# Deyo Skill

[English Version](./README.en.md)

`deyo` 是一个同时面向 **Codex / OpenAI Agents** 和 **Claude Code** 的 skill，用来指导代理优先通过已安装的 `deyo` 命令行工具完成链接转写，而不是走网页界面。

它覆盖了 `deyo` CLI 的安装、一次性 API key 登录、本地配置检查、链接转写命令拼装，以及常见故障处理规则。

`deyo/SKILL.md` 的 frontmatter 同时兼容 Codex 和 Claude Code 的 skill 规范，两边复用同一份主说明文件，仅 `agents/` 下的元信息按平台拆分。

## 适用场景

在以下情况下使用这个 skill：

- 用户想安装或配置 `deyo`
- 用户想通过 `deyo` 转写一个链接
- 用户想保存一次 API key，避免后续每次重复传参
- 用户想确认 `--source`、`--format`、`-O`、stdout 输出或进度行为

## 核心规则

- 优先使用系统里已安装的 `deyo` 命令
- 如果 `deyo` 不存在，先安装已发布包 `@casatwy/deyo`
- 生产环境默认使用 CLI 自带的服务地址 `https://deyo.miaobi.fun`
- 只有用户明确要求本地开发环境时，才传 `--base-url http://deyo.mac-studio`
- 不要虚构 API key；如果用户没有提供，要求用户先到 `/me/api-keys` 创建
- 用户提供 API key 后，用 `deyo auth login --api-key '...'` 保存到本地，方便后续复用
- 除非用户明确要求其他结果语言，否则默认追加 `--language zh`

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
deyo [--source <name>] [--language <value>] [--format <value>] [-O <path>] <url>
```

## 输出规则

- 如果未传 `-O`，最终转写结果输出到 stdout
- 如果未传 `--format`，CLI 会根据输出文件后缀自动推断格式
- `.txt -> text`
- `.srt -> srt`
- `.vtt -> vtt`
- `.json -> json`
- 进度和状态信息写入 stderr
- 当上游任务进入 `transcribing` 阶段后，CLI 会在单行终端内原地刷新进度

## 推荐工作流

1. 先确认机器上是否已安装 `deyo`
2. 确认目标链接、输出格式和输出路径
3. 如果本地尚未登录，向用户索取 API key 并执行 `deyo auth login`
4. 仅在需要时区分生产环境或本地开发环境
5. 除非用户明确指定其他语言，否则追加 `--language zh`
6. 仅在强制指定平台有帮助时才加 `--source`
7. 运行最终命令

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

强制使用 YouTube 源并导出 SRT：

```bash
deyo --language zh --source youtube --format srt -O ./tmp/out.srt 'https://youtu.be/xxxx'
```

直接从 stdout 读取 JSON：

```bash
deyo --language zh --format json 'https://www.bilibili.com/video/BVxxxx'
```

## 故障排查

- `deyo: command not found`：先安装 `@casatwy/deyo`
- `缺少 API key。请传 --api-key、设置 DEYO_API_KEY，或先执行 deyo auth login`：让用户先在 `/me/api-keys` 创建 key，再执行 `deyo auth login`
- `API key 无效或不存在`：要求用户重新生成有效 key
- `剩余分钟不足`：当前账号分钟余额不足
- 如果用户反馈没有进度更新，先确认其使用的是当前已发布 CLI，且任务不是直接返回字幕的场景

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

- `deyo/SKILL.md`：skill 的主说明文件，定义适用场景、规则和示例（同时兼容 Codex、Claude Code 与 Gemini CLI）
- `deyo/agents/openai.yaml`：OpenAI Agents 侧的显示名、简述和默认提示词配置
- `deyo/agents/claude.yaml`：Claude Code 侧的显示名、安装路径与触发方式说明
- `deyo/agents/gemini.yaml`：Gemini CLI 侧的安装说明及相关元信息说明
