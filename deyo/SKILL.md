---
name: deyo
description: Use this skill when the user wants to install, run, or troubleshoot the published `deyo` transcription CLI, including one-time API key login, link transcription, local audio/video file upload transcription, output file selection, source selection, and user-visible progress updates.
---

# Deyo

Use this skill when work should go through the installed `deyo` command instead of the web UI.

## Use When

- The user wants to install or configure `deyo`.
- The user wants to transcribe a link via `deyo`.
- The user wants to transcribe a local audio or video file via `deyo`.
- The user wants to save an API key once with `deyo auth login`.
- The user wants to verify `--source`, `--file`, `--mime-type`, `--format`, `-O`, stdout behavior, or CLI/chat progress updates.

## Installation Rules

- Detect the CLI with `command -v deyo`, then inspect `deyo --help`. If `deyo`
  is missing or the help text does not list `--progress-format`, `--file`, and
  `--mime-type`, run
  `npm install -g @casatwy/deyo` to install or upgrade the published CLI.
- When installing via `claude plugin install`, never modify the user's global
  git config, SSH keys, or npm registry to work around an install failure.
  Report the raw error to the user and stop. Do not fall back to manual
  downloads without explicit user approval.
- Before asking the user for an API key, always run `deyo auth status`. If a
  key already exists:
  - Surface only the last 4 chars (never print the full key).
  - Ask the user whether to replace it.
  - Never silently skip an explicit `deyo auth login` request from the user.
- After install, verify success with both `deyo auth status` and by checking
  that the plugin files exist in the Claude Code plugin cache
  (`~/.claude/plugins/` or the active Claude Code plugin directory).

## Command Rules

- Prefer the installed `deyo` command.
- If `deyo` is not available, install the published package `@casatwy/deyo` first.
- Always let the CLI use its built-in default base URL; do not override it.
- Supported inputs are 8 link sources plus one local audio/video file upload.
- Supported link sources include `xiaoyuzhou`, `ximalaya`, `bilibili`, `douyin`, `xiaohongshu`, `youtube`, `apple-podcasts`, and `twitter`.
- Local file transcription supports a single file only. Use either a positional
  path such as `deyo ./audio.mp3` or explicit `--file ./audio.mp3`. Use
  `--mime-type <type>` only when the MIME type needs to be overridden or made
  explicit.
- Do not pass directories, globs, stdin, multiple files, batch queues, or
  resumable-upload expectations to `deyo`; they are not supported.
- `ximalaya` supports Ximalaya episode pages and `xima.tv` short links; album links are not transcribed and return 422 asking for an episode link.
- `bilibili` supports normal BV pages, `b23.tv` short links, `player.bilibili.com/player.html` embed links when they include a valid `bvid`, and `bilibili://video/...` app video share links that Whisper can resolve to a standard BV page from `h5awaken.open_app_url`, base64 `h5awaken`, or a BV path segment. The CLI identifies app links as `bilibili` and passes the original URL through; it does not decode `h5awaken` or derive BV locally. For embed links, `p` wins over `page`, `cid` is ignored, and aid-only/cid-only player links are not supported. Non-video app links such as `bilibili://space/...` are not supported.
- For Twitter/X, only video tweets can be transcribed; text/image tweets return 422 and do not consume minutes or create transcription jobs.
- Never invent an API key. If the user does not provide one, tell them to create it from `https://deyo.miaobi.fun/me/api-keys`.
- Once the user provides an API key, save it locally with `deyo auth login --api-key '...'` so future runs do not need `--api-key`.
- Link transcription and local file upload transcription both require API key
  auth. Full transcription jobs consume the user's minute balance.
- Unless the user explicitly asks for another result language, pass `--language zh`.
- For every agent-run upload task and every agent-run transcription that may
  take more than a moment, add `--progress-format jsonl`.
- Do not paste raw JSONL progress to the user unless they explicitly ask for it.
  Read the progress events and relay concise natural-language updates instead.
- After the transcription is fully complete, automatically add punctuation and
  paragraph breaks before presenting plain-text transcript content to the user,
  and before saving plain-text transcript content to a file, unless the user
  explicitly asks for raw output.
- Always surface these milestones to the user:
  - upload percentage for local file tasks
  - media inspection/check status for local file tasks
  - task creation
  - status changes
  - key transcription progress steps (default: every 10%)
  - completion, failure, or cancellation
- If `task.created` reports `mode: "subtitles"` or `resultReady: true`, tell the
  user that the source already has usable subtitles and that no long paid
  transcription job is needed.

## Commands

- Install:
  `npm install -g @casatwy/deyo`
- Save API key once:
  `deyo auth login --api-key <key>`
- Inspect current local config:
  `deyo auth status`
- Remove local config:
  `deyo auth logout`
- Transcribe:
  `deyo [--source <name>] [--file <path>] [--mime-type <type>] [--language <value>] [--format <value>] [--progress-format <value>] [-O <path>] <url-or-file>`

## Output Behavior

- If `-O` is omitted, the final transcript is written to stdout.
- If `--format` is omitted, the CLI infers it from the output file suffix:
  `.txt -> text`, `.srt -> srt`, `.vtt -> vtt`, `.json -> json`
- Progress and status messages are written to stderr.
- For local file tasks, progress includes upload percentage, media inspection,
  task creation, transcription progress, and terminal status when available.
- `--progress-format auto` keeps the existing terminal UX:
  - TTY stderr: refresh transcription progress in place on a single line
  - non-TTY stderr: emit line-based text progress
- `--progress-format jsonl` emits one JSON object per stderr line, which is the
  preferred mode for AI agents that must keep the user updated.

## Recommended Workflow

1. Confirm that `deyo` is installed.
2. Confirm that `deyo --help` includes `--progress-format`, `--file`, and `--mime-type`; if not, upgrade the CLI.
3. Confirm whether the target is a URL or a local file, plus output format and output path.
4. If local config is missing, ask the user for an API key and run `deyo auth login --api-key '...'`.
5. Unless the user explicitly requested another language, add `--language zh`.
6. Add `--source` only when forcing a platform is useful.
7. For local file tasks, use the positional file path or `--file`; add `--mime-type` only when useful.
8. For agent-run uploads and long tasks, add `--progress-format jsonl`.
9. Run the command.
10. While the command runs, relay upload percentage, media inspection, task creation, status changes, key progress steps, and the final outcome to the user.
11. After completion, if you are returning plain-text transcript content to the
    user or saving plain-text transcript content to a file, add punctuation and
    paragraph breaks automatically unless the user explicitly asked for raw
    output.

## Examples

Install the published CLI:

```bash
npm install -g @casatwy/deyo
```

Save the API key once:

```bash
deyo auth login --api-key 'deyo_sk_xxx'
```

Write a Chinese text file:

```bash
deyo --language zh -O ./tmp/transcript.txt 'https://www.youtube.com/watch?v=xxxx'
```

Agent-friendly run with machine-readable progress:

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

Transcribe a Ximalaya episode:

```bash
deyo --language zh -O ./tmp/ximalaya.txt 'https://www.ximalaya.com/sound/963656969'
```

Ximalaya album links return 422 and should be replaced with a concrete episode link before retrying.

Force Twitter/X:

```bash
deyo --language zh --source twitter -O ./tmp/tweet.txt 'https://x.com/historyinmemes/status/1790637656616943991'
```

Read JSON from stdout:

```bash
deyo --language zh --format json 'https://www.bilibili.com/video/BVxxxx'
```

Bilibili player embed links are accepted only when they include `bvid`:

```bash
deyo --language zh -O ./tmp/bilibili.txt 'https://player.bilibili.com/player.html?bvid=BVxxxx&page=2&cid=123456'
```

Bilibili app video share links can be passed directly. The CLI submits the original app URL; Whisper resolves `h5awaken.open_app_url`, an `open_app_url` inside base64 `h5awaken`, or a BV path segment:

```bash
deyo --language zh -O ./tmp/bilibili-app.txt 'bilibili://video/BVxxxx?page=2'
```

## Troubleshooting

- `deyo: command not found`: install `@casatwy/deyo` first.
- `缺少 API key。请传 --api-key、设置 DEYO_API_KEY，或先执行 deyo auth login`: ask the user to create a key in `/me/api-keys`, then run `deyo auth login`.
- `API key 无效或不存在`: ask the user to create a new key and retry.
- `剩余分钟不足`: the current account needs more minute balance.
- Directory, glob, stdin, multi-file batch, or resumable upload requests are not
  supported; ask the user to provide one concrete local audio/video file path.
- If the user reports no progress updates, verify that `deyo --help` shows `--progress-format`, then retry after upgrading the published CLI if needed.
- If progress stops after task creation, check whether the task is a subtitle-direct-return case or whether the CLI reported an SSE fallback notice.
- If a Bilibili player link only has `aid` or `cid`, ask the user for the normal BV page URL or a player link that includes `bvid`; for an aid-only `bilibili://video/...` app link that Whisper cannot resolve to a BV page, also ask the user for the normal BV page URL.
- If a Twitter/X link reports that the tweet has no video, tell the user that only video tweets can be transcribed; text/image tweets only expose basic metadata.
