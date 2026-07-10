# Deyo Website

Transform podcast or video to text： [https://deyo.miaobi.fun](https://deyo.miaobi.fun)

# Deyo Skill

[中文版](./README.md)

`deyo` is a skill for **Codex / OpenAI Agents**, **Claude Code**, and **OpenClaw** that tells the agent to use the installed `deyo` CLI for link transcription or local audio/video file upload transcription instead of the web UI.

It documents how to install the CLI, save an API key once, inspect local auth state, build link/file transcription commands, keep users updated with AI-visible progress, and troubleshoot common failures.

`deyo/SKILL.md` is a shared main definition file that works with Codex / OpenAI Agents, Claude Code, and OpenClaw skill conventions. Only the per-platform metadata under `agents/` is split.

## When To Use

Use this skill when:

- The user wants to install or configure `deyo`
- The user wants to transcribe a link with `deyo`
- The user wants to upload and transcribe a local audio/video file with `deyo`
- The user wants to save an API key once and reuse it later
- The user wants to verify `--source`, `--file`, `--mime-type`, `--format`, `-O`, stdout behavior, CLI progress behavior, or chat-visible progress behavior

## Core Rules

- Prefer the installed `deyo` command
- If `deyo` is missing, or `deyo --help` does not list `--progress-format`, `--file`, and `--mime-type`, install or upgrade the published package `@casatwy/deyo` first
- In production, use the CLI default service URL `https://deyo.miaobi.fun`
- Only pass `--base-url http://deyo.mac-studio` when the user explicitly wants local development
- Never invent an API key; if the user does not provide one, ask them to create it from `/me/api-keys`
- Once the user provides an API key, save it locally with `deyo auth login --api-key '...'`
- Unless the user explicitly requests another output language, default to `--language zh`
- Supported inputs are 8 link sources plus one local audio/video file upload
- Supported link sources are `xiaoyuzhou`, `ximalaya`, `bilibili`, `douyin`, `xiaohongshu`, `youtube`, `apple-podcasts`, and `twitter`
- Local files can be passed as `deyo ./audio.mp3` or `deyo --file ./audio.mp3`; add `--mime-type` only when the media type needs to be overridden or made explicit
- Directories, globs, stdin, batch queues, and resumable uploads are not supported; the user must provide one concrete local audio/video file
- `ximalaya` supports Ximalaya episode pages and `xima.tv` short links; album links are not transcribed and return 422 asking for an episode link
- `bilibili` supports normal BV pages, `b23.tv` short links, `player.bilibili.com/player.html` embed links when they include a valid `bvid`, and `bilibili://video/...` app video share links that Whisper can resolve to a standard BV page from `h5awaken.open_app_url`, base64 `h5awaken`, or a BV path segment; the CLI identifies app links and passes the original URL through without decoding `h5awaken` or deriving BV locally; for embed links, `p` wins over `page`, `cid` is ignored, and aid-only/cid-only player links are not supported; non-video app links such as `bilibili://space/...` are not supported
- For Twitter/X, only video tweets can be transcribed; text/image tweets return 422 and do not consume minutes or create transcription jobs
- Link transcription and local file upload transcription both require API key auth; full transcription jobs consume the user's minute balance
- For every agent-run upload task, and every agent-run transcription task that may take more than a moment, default to `--progress-format jsonl`
- Do not dump raw JSONL progress to the user; read it and relay upload percentage, media inspection, task creation, status changes, key transcription percentages, and final outcome in natural language instead
- If `task.created` reports `mode: subtitles` or `resultReady: true`, tell the user that usable subtitles were returned directly and no long transcription job is needed

## Command Reference

Install the CLI:

```bash
npm install -g @casatwy/deyo
```

Save an API key:

```bash
deyo auth login --api-key 'deyo_sk_xxx'
```

Inspect local auth state:

```bash
deyo auth status
```

Clear local auth state:

```bash
deyo auth logout
```

Run a transcription:

```bash
deyo [--source <name>] [--file <path>] [--mime-type <type>] [--language <value>] [--format <value>] [--progress-format <value>] [-O <path>] <url-or-file>
```

## Output Behavior

- If `-O` is omitted, the final transcript is written to stdout
- If `--format` is omitted, the CLI infers the format from the output file suffix
- `.txt -> text`
- `.srt -> srt`
- `.vtt -> vtt`
- `.json -> json`
- Progress and status messages are written to stderr
- Local file task progress includes upload percentage, media inspection, task creation, transcription progress, and terminal status when available
- `--progress-format auto` is the default
- With TTY stderr, `auto` keeps the current in-place single-line progress refresh
- With non-TTY stderr, `auto` falls back to line-based text progress so logs and agent output do not get polluted by control characters
- `--progress-format jsonl` emits one JSON object per stderr line and is the preferred mode for AI agents that must keep users updated

## Recommended Workflow

1. Confirm that `deyo` is installed
2. Confirm that `deyo --help` includes `--progress-format`, `--file`, and `--mime-type`
3. Confirm whether the target is a URL or a local file, plus output format and output path
4. If local auth is missing, ask the user for an API key and run `deyo auth login`
5. Only choose between production and local development when needed
6. Unless the user explicitly asks for another language, add `--language zh`
7. Add `--source` only when forcing a platform is useful
8. For local file tasks, use the positional file path or `--file`; add `--mime-type` only when useful
9. For agent-run uploads and long tasks, add `--progress-format jsonl`
10. Run the final command and relay upload percentage, media inspection, task creation, status changes, key transcription progress milestones, and the final outcome to the user

## Examples

Install the published CLI:

```bash
npm install -g @casatwy/deyo
```

Save an API key:

```bash
deyo auth login --api-key 'deyo_sk_xxx'
```

Write a Chinese text file:

```bash
deyo --language zh -O ./tmp/transcript.txt 'https://www.youtube.com/watch?v=xxxx'
```

Agent-friendly machine-readable progress:

```bash
deyo --language zh --progress-format jsonl -O ./tmp/transcript.txt 'https://www.youtube.com/watch?v=xxxx'
```

Transcribe a local file:

```bash
deyo --language zh -O ./tmp/audio.txt ./audio.mp3
```

Transcribe a local file with an explicit file flag and MIME type:

```bash
deyo --language zh --progress-format jsonl --file ./audio.mp3 --mime-type audio/mpeg -O ./tmp/audio.txt
```

Force YouTube and export SRT:

```bash
deyo --language zh --source youtube --format srt -O ./tmp/out.srt 'https://youtu.be/xxxx'
```

Force Twitter/X:

```bash
deyo --language zh --source twitter -O ./tmp/tweet.txt 'https://x.com/historyinmemes/status/1790637656616943991'
```

Read JSON from stdout:

```bash
deyo --language zh --format json 'https://www.bilibili.com/video/BVxxxx'
```

Bilibili player embed links must include `bvid`:

```bash
deyo --language zh -O ./tmp/bilibili.txt 'https://player.bilibili.com/player.html?bvid=BVxxxx&page=2&cid=123456'
```

Bilibili app video share links can be passed directly. The CLI submits the original app URL; Whisper resolves `h5awaken.open_app_url`, an `open_app_url` inside base64 `h5awaken`, or a BV path segment:

```bash
deyo --language zh -O ./tmp/bilibili-app.txt 'bilibili://video/BVxxxx?page=2'
```

## Troubleshooting

- `deyo: command not found`: install `@casatwy/deyo` first
- `缺少 API key。请传 --api-key、设置 DEYO_API_KEY，或先执行 deyo auth login`: ask the user to create a key from `/me/api-keys`, then run `deyo auth login`
- `API key 无效或不存在`: ask the user to generate a new valid key
- `剩余分钟不足`: the current account does not have enough minute balance
- Directory, glob, stdin, multi-file batch, and resumable upload requests are not supported; ask the user for one concrete local audio/video file path
- If the user reports missing progress updates, verify that `deyo --help` includes `--progress-format`; if not, upgrade the published CLI first
- If a task ends almost immediately, check whether it was a direct-subtitle-return case rather than a long transcription path
- If a Bilibili player link only has `aid` or `cid`, ask the user for the normal BV page URL or a player link that includes `bvid`; for an aid-only `bilibili://video/...` app link that Whisper cannot resolve to a BV page, also ask the user for the normal BV page URL
- If a Twitter/X link reports that the tweet has no video, tell the user that only video tweets can be transcribed; text/image tweets only expose basic metadata
- If live progress stops mid-run, check whether the CLI emitted an SSE fallback notice

## Use With Claude Code

Claude Code loads skills from `~/.claude/skills/<name>/SKILL.md`. The `deyo/SKILL.md` in this repo already follows that convention. You can install it in two ways:

User-level (available everywhere):

```bash
mkdir -p ~/.claude/skills
ln -snf "$(pwd)/deyo" ~/.claude/skills/deyo
```

Project-level (only inside one repo):

```bash
mkdir -p .claude/skills
ln -snf "$(realpath ./deyo)" .claude/skills/deyo
```

Once installed, Claude Code will suggest the skill automatically in matching scenarios. You can also invoke it explicitly:

```text
/deyo turn this YouTube link into a Chinese SRT
```

Claude-side metadata (display name, default prompt, etc.) lives in `deyo/agents/claude.yaml`, parallel to `openai.yaml` and independent from it.

## Use With Codex / OpenAI Agents

See `deyo/agents/openai.yaml` and load `deyo/SKILL.md` through the Codex / OpenAI Agents skill registration flow.

## Use With OpenClaw / ClawHub

If you already use OpenClaw, prefer its native `openclaw skills` commands to install `deyo` from ClawHub. ClawHub is the public skill registry for OpenClaw. If you only want search or a fallback install path, you can also use the standalone `clawhub` CLI directly.

First make sure the machine already has the `deyo` command:

```bash
npm install -g @casatwy/deyo
```

Recommended flow: install the skill into the current workspace:

```bash
openclaw skills search "deyo"
openclaw skills install deyo
```

After installation, save the API key once:

```bash
deyo auth login --api-key 'deyo_sk_xxx'
```

To update all installed skills later:

```bash
openclaw skills update --all
```

If you prefer the standalone ClawHub CLI, you can also do:

```bash
npm install -g clawhub

clawhub search "deyo"
clawhub install deyo
```

Once installed, you can ask OpenClaw directly, for example:

```text
Use deyo to turn this YouTube link into a Chinese SRT
```

## Use With Gemini CLI

Gemini CLI natively supports reading `SKILL.md` with frontmatter. You can install it via the following commands:

User-level (available everywhere):

```bash
gemini skills install "$(pwd)/deyo" --scope user
```

Project-level (only inside one repo):

```bash
gemini skills install "$(realpath ./deyo)" --scope workspace
```

After installation, run `/skills reload` in an interactive Gemini CLI session to enable it. Additional notes are recorded in `deyo/agents/gemini.yaml`.

## Directory Layout

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

## Related Files

- `deyo/SKILL.md`: main skill definition with usage conditions, rules, and examples (works for Codex, Claude Code, OpenClaw, and Gemini CLI)
- `deyo/agents/openai.yaml`: OpenAI Agents metadata — display name, short description, default prompt
- `deyo/agents/claude.yaml`: Claude Code metadata — display name, install path, invocation notes
- `deyo/agents/gemini.yaml`: Gemini CLI metadata — installation and integration notes
