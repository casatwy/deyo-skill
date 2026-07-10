# Deyo Website

Podcast and video transcription: [https://deyo.miaobi.fun](https://deyo.miaobi.fun)

# Deyo Skill

[中文版](./README.md)

`deyo` is a skill for **Codex / OpenAI Agents**, **Claude Code**, **OpenClaw**, and **Gemini CLI**. It tells agents to use the installed `deyo` CLI for link transcription or local audio/video file upload transcription instead of the web UI.

It documents CLI installation, API key authentication, local config precedence, link/file command construction, AI-visible progress, result format selection, development base URLs, and common troubleshooting rules.

`deyo/SKILL.md` is the shared main skill definition. Platform metadata is split under `agents/`. Claude's current recommended path is plugin / marketplace installation; legacy `~/.claude/skills` installation is only a fallback.

## When To Use

Use this skill when:

- The user wants to install, configure, or upgrade `deyo`
- The user wants to transcribe a supported link with `deyo`
- The user wants to upload and transcribe a local audio/video file with `deyo`
- The user wants to save an API key once and reuse it later
- The user wants to verify `--api-key`, `DEYO_API_KEY`, `--base-url`, `DEYO_BASE_URL`, or local config precedence
- The user wants to verify `--source`, `--file`, `--mime-type`, `--format`, `--progress-format`, `-O`, stdout behavior, or chat-visible progress behavior
- The user wants to troubleshoot upload, media checks, direct subtitles, minute balance, or unsupported source branches

## Core Rules

- Prefer the installed `deyo` command.
- If `deyo` is missing, or `deyo --help` does not list `--progress-format`, `--file`, and `--mime-type`, install or upgrade the published package `@casatwy/deyo` first.
- Use the production service and the CLI's default configuration by default; only pass `--base-url http://deyo.mac-studio` when the user explicitly asks for local/development mode.
- Never invent an API key; if the user does not provide one, ask them to create it from `https://deyo.miaobi.fun/me/api-keys`.
- Once the user provides an API key, save it locally with `deyo auth login --api-key '...'`.
- Unless the user explicitly requests another output language, default to `--language zh`.
- Link transcription and local file upload transcription both require API key auth; full transcription jobs consume the user's minute balance.
- If YouTube has directly usable subtitles, the CLI returns subtitle output directly without a long transcription job and without consuming minutes.
- For every agent-run upload task, and every agent-run transcription task that may take more than a moment, default to `--progress-format jsonl`.
- Do not dump raw JSONL progress to the user; read it and relay upload percentage, media inspection, task creation, status changes, key transcription percentages, and final outcome in natural language instead.
- If `task.created` reports `mode: "subtitles"` or `resultReady: true`, tell the user that usable subtitles were returned directly and no long transcription job is needed.

## Supported Inputs

Supported inputs are 8 link sources plus one local audio/video file upload.

Supported link sources:

- `xiaoyuzhou`
- `ximalaya`
- `bilibili`
- `douyin`
- `xiaohongshu`
- `youtube`
- `apple-podcasts`
- `twitter`

Local file upload rules:

- Only one regular audio or video file is supported.
- Use `deyo ./audio.mp3`, `deyo --file ./audio.mp3`, or `deyo -- ./audio.mp3` to explicitly treat the single argument after `--` as a path or link.
- Add `--mime-type` only when the extension is ambiguous, auto-detection is unreliable, or the media type must be overridden, for example `audio/mpeg`, `audio/mp4`, or `video/mp4`.
- Directories, globs, stdin, batch queues, and resumable uploads are not supported.
- Local files are always the `upload` source; do not pass any non-`upload` `--source` for local files.

## Config Precedence

API key precedence:

1. `--api-key`
2. Environment variable `DEYO_API_KEY`
3. Local config file created by `deyo auth login`

Base URL precedence:

1. `--base-url`
2. Environment variable `DEYO_BASE_URL`
3. `baseUrl` in the local config file
4. CLI default production URL `https://deyo.miaobi.fun`

For normal use and production service access, do not pass `--base-url` explicitly. Only pass it when the user explicitly asks for local/development mode:

```bash
deyo auth login --api-key 'deyo_sk_xxx' --base-url http://deyo.mac-studio
deyo --base-url http://deyo.mac-studio --language zh -O ./tmp/out.txt 'https://www.youtube.com/watch?v=xxxx'
```

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
deyo [--api-key <key>] [--source <name>] [--file <path>] [--mime-type <type>] [--language <value>] [--format <value>] [--progress-format <value>] [--base-url <url>] [-O <path>] <url-or-file>
```

## Output Formats

`--format` supports:

- `text`
- `srt`
- `vtt`
- `json`
- `verbose_json`

If `-O` is omitted, the final transcript is written to stdout. If `-O` is provided, the result is written to that file.

If `--format` is omitted, the CLI infers common formats from the output file suffix:

- `.txt -> text`
- `.srt -> srt`
- `.vtt -> vtt`
- `.json -> json`
- otherwise `text`

If `verbose_json` is needed, pass `--format verbose_json` explicitly.

Progress and status messages are written to stderr, not stdout or the `-O` result file.

## AI Plain-Text Post-Processing

The skill keeps the behavior of automatically adding punctuation and paragraph breaks for plain text, but this is agent-side post-processing after the agent receives `text` output. It is not a built-in CLI feature. The CLI outputs the raw result it receives.

Do not rewrite results in these cases:

- The user asks for raw or verbatim output.
- The command uses `--format srt`, `--format vtt`, `--format json`, or `--format verbose_json`.
- The user asks to save the original CLI result directly with `-O`.
- The output is intended for machine parsing, subtitle timelines, JSON structure, or later automation.

## Progress Formats And Events

`--progress-format` supports:

- `auto`
- `text`
- `jsonl`

`auto` is the default:

- With TTY stderr, it keeps the in-place single-line progress refresh.
- With non-TTY stderr, it falls back to line-based text progress so logs and agent output do not get polluted by control characters.

`--progress-format jsonl` emits one JSON object per stderr line and is the preferred mode for AI agents that must keep users updated reliably.

Local upload events:

- `upload.hashing`
- `upload.started`
- `upload.progress`
- `upload.completed`
- `upload.checking`
- `upload.ready`
- `upload.aborted`
- `upload.failed`

Transcription task events:

- `task.created`
- `task.status_changed`
- `task.progress`
- `task.completed`
- `task.failed`
- `task.cancelled`
- `task.result_written`
- `task.notice`

Local upload events do not include signed URLs, file hashes, or part ETags. Upload sources in task and result JSON are redacted as `upload:file`.

## Recommended Workflow

1. Confirm that `deyo` is installed.
2. Confirm that `deyo --help` includes `--progress-format`, `--file`, `--mime-type`, `json`, and `verbose_json`.
3. Confirm whether the target is a URL or a local file, plus output format and output path.
4. If local auth is missing, ask the user for an API key and run `deyo auth login --api-key '...'`.
5. Add `--base-url http://deyo.mac-studio` only when the user explicitly asks for local/development mode.
6. Unless the user explicitly asks for another language, add `--language zh`.
7. Add `--source` only when forcing a platform is useful; do not pass a non-`upload` `--source` for local files.
8. For local file tasks, use the positional file path or `--file`; add `--mime-type` only when useful.
9. For agent-run uploads and long tasks, add `--progress-format jsonl`.
10. Run the final command and relay upload percentage, media inspection, task creation, status changes, key transcription progress milestones, and the final outcome to the user.
11. Only after receiving plain text, and only when the user did not request raw output, the agent may add punctuation and paragraph breaks.

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

Export VTT:

```bash
deyo --language zh --format vtt -O ./tmp/out.vtt 'https://www.youtube.com/watch?v=xxxx'
```

Read JSON from stdout:

```bash
deyo --language zh --format json 'https://www.bilibili.com/video/BVxxxx'
```

Read more complete JSON:

```bash
deyo --language zh --format verbose_json 'https://www.bilibili.com/video/BVxxxx'
```

Use a temporary API key:

```bash
deyo --api-key 'deyo_sk_other' --language zh 'https://www.bilibili.com/video/BVxxxx'
```

Use the development environment explicitly:

```bash
deyo --base-url http://deyo.mac-studio --language zh -O ./tmp/dev.txt 'https://www.youtube.com/watch?v=xxxx'
```

Transcribe a Ximalaya episode:

```bash
deyo --language zh -O ./tmp/ximalaya.txt 'https://www.ximalaya.com/sound/963656969'
```

Force Twitter/X:

```bash
deyo --language zh --source twitter -O ./tmp/tweet.txt 'https://x.com/historyinmemes/status/1790637656616943991'
```

Bilibili player embed links must include `bvid`:

```bash
deyo --language zh -O ./tmp/bilibili.txt 'https://player.bilibili.com/player.html?bvid=BVxxxx&page=2&cid=123456'
```

Bilibili app video share links can be passed directly. The CLI submits the original app URL; Whisper resolves `h5awaken.open_app_url`, an `open_app_url` inside base64 `h5awaken`, or a BV path segment:

```bash
deyo --language zh -O ./tmp/bilibili-app.txt 'bilibili://video/BVxxxx?page=2'
```

## Source Boundaries

- Ximalaya supports episode pages and `xima.tv` short links; album links return 422 asking for a concrete episode, do not consume minutes, and do not create transcription jobs.
- Xiaohongshu image notes return an unsupported branch and are not transcribed.
- Douyin image posts return an unsupported branch and are not transcribed.
- For Twitter/X, only video tweets can be transcribed; text/image tweets return 422, do not consume minutes, and do not create transcription jobs.
- If YouTube has directly usable subtitles, the CLI outputs TXT / SRT / VTT / JSON directly without consuming minutes.
- Bilibili supports normal BV pages, `b23.tv` short links, `player.bilibili.com/player.html` embed links when they include a valid `bvid`, and `bilibili://video/...` app video share links that Whisper can resolve to a standard BV page from `h5awaken.open_app_url`, base64 `h5awaken`, or a BV path segment; the CLI identifies app links and passes the original URL through without decoding `h5awaken` or deriving BV locally; for embed links, `p` wins over `page`, `cid` is ignored, and aid-only/cid-only player links are not supported; non-video app links such as `bilibili://space/...` are not supported.

## Troubleshooting

- `deyo: command not found`: install `@casatwy/deyo` first.
- `缺少 API key。请传 --api-key、设置 DEYO_API_KEY，或先执行 deyo auth login`: ask the user to create a key from `/me/api-keys`, then run `deyo auth login`, or use `--api-key` / `DEYO_API_KEY` temporarily.
- `API key 无效或不存在`: ask the user to generate a new valid key.
- `剩余分钟不足`: the current account does not have enough minute balance; buy a minute package first.
- Directory, glob, stdin, multi-file batch, and resumable upload requests are not supported; ask the user for one concrete local audio/video file path.
- `--mime-type` is only for local files and must be `audio/*` or `video/*`.
- If local MIME cannot be detected, pass `--mime-type audio/*` or `--mime-type video/*` explicitly.
- Empty local files, non-regular files, and files without a transcribable audio track cannot be transcribed; ask the user for a regular audio or video file.
- Media check failure, no audio track, unavailable duration, or ffprobe failure usually means the user should try another file or first verify locally that the media plays and contains an audio track.
- A 403 while uploading parts usually means the signed upload URL expired or the upload signature failed; the CLI re-signs and retries, but if it still fails, preserve the raw error.
- If uploaded file SHA-256 verification fails, ask the user to select the file again and retry.
- Interrupting the local CLI after task creation does not cancel the server-side task; the CLI reports that server transcription is still running or the upload is still being processed.
- If the user reports missing progress updates, verify that `deyo --help` includes `--progress-format`; if not, upgrade the published CLI first.
- If live progress stops mid-run, check whether the CLI emitted an SSE fallback notice.
- If a task ends almost immediately, check whether it was a direct-subtitle-return case rather than a long transcription path.
- If a Bilibili player link only has `aid` or `cid`, ask the user for the normal BV page URL or a player link that includes `bvid`; for an aid-only `bilibili://video/...` app link that Whisper cannot resolve to a BV page, also ask the user for the normal BV page URL.
- If a Twitter/X link reports that the tweet has no video, tell the user that only video tweets can be transcribed; text/image tweets only expose basic metadata.

## Use With Claude Code

Claude's current primary path is installing the plugin through the official Deyo marketplace:

```bash
npm install -g @casatwy/deyo

claude plugin marketplace add https://deyo.miaobi.fun/ai/install/claude/marketplace.json

claude plugin install deyo@deyo-official
```

If `claude plugin install` fails, preserve the raw error. Do not modify the user's global git / SSH / npm config and do not manually bypass the marketplace flow.

Claude plugin cache checks only apply to plugin installations performed through `claude plugin install`. In that case, check Claude Code's plugin cache directory, such as `~/.claude/plugins/` or the active Claude Code plugin directory.

Legacy fallback: if the current environment cannot use Claude plugin / marketplace installation, copy or symlink `deyo/` into a Claude skills directory.

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

Legacy skills installation does not use plugin cache checks; only verify that the target `SKILL.md` is readable by Claude Code.

Once installed, Claude Code will suggest the skill automatically in matching scenarios. You can also invoke it explicitly:

```text
/deyo turn this YouTube link into a Chinese SRT
```

Claude-side metadata lives in `deyo/agents/claude.yaml`. Claude plugin metadata lives in the repository-root `.claude-plugin/plugin.json`.

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
├── .claude-plugin/
│   └── plugin.json
└── deyo/
    ├── SKILL.md
    └── agents/
        ├── openai.yaml
        ├── claude.yaml
        └── gemini.yaml
```

## Related Files

- `deyo/SKILL.md`: main skill definition with usage conditions, rules, and examples.
- `deyo/agents/openai.yaml`: Codex / OpenAI Agents metadata.
- `deyo/agents/claude.yaml`: Claude Code display, invocation, and legacy skill notes.
- `deyo/agents/gemini.yaml`: Gemini CLI installation and integration notes.
- `.claude-plugin/plugin.json`: Claude plugin / marketplace metadata.
