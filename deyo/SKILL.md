---
name: deyo
description: Use this skill when the user wants to install, configure, run, automate, or troubleshoot the published `deyo` transcription CLI for link transcription, single local audio/video file upload transcription, API key login, output formats, progress reporting, development base URLs, or Claude/Codex/OpenClaw AI-agent installation flows.
---

# Deyo

Use the installed `deyo` CLI for Deyo transcription tasks instead of the web UI.

## Install And Discovery

- Prefer the installed `deyo` command. Check with `command -v deyo`, then inspect `deyo --help`.
- If `deyo` is missing, or `deyo --help` does not list `--progress-format`, `--file`, `--mime-type`, and `verbose_json`, install or upgrade the published CLI:

```bash
npm install -g @casatwy/deyo
```

- For Claude Code installation, prefer the current Claude plugin/marketplace path from the Deyo install page. Use legacy `~/.claude/skills/deyo` copy/symlink installation only as a fallback when the user explicitly asks for it or marketplace/plugin install is unavailable.
- When installing through `claude plugin marketplace add` or `claude plugin install`, do not modify the user's global git config, SSH keys, npm registry, or plugin manifest to work around failures. Report the raw error and stop unless the user gives explicit instructions.
- Check Claude plugin cache files only when the task is specifically a Claude plugin installation. Do not use plugin cache presence as proof that the standalone CLI or a legacy skill install succeeded.

## Auth And Base URL

- Never invent or expose an API key. If the user has not provided one and no local config exists, tell them to create one at `https://deyo.miaobi.fun/me/api-keys`.
- Before asking for a new API key, run `deyo auth status`. Surface only masked key information; never print the full key.
- Save a user-provided key once with:

```bash
deyo auth login --api-key '<key>'
```

- API key resolution order for transcription commands is:
  `--api-key` -> `DEYO_API_KEY` -> local config from `deyo auth login`.
- API key auth is required for both link transcription and local file upload transcription. Full transcription jobs consume the user's minute balance.
- Base URL resolution order is:
  `--base-url` -> `DEYO_BASE_URL` -> local config -> CLI default `https://deyo.miaobi.fun`.
- For normal user tasks, use the production service and CLI defaults; do not pass `--base-url`.
- Only when the user explicitly asks for local/development Deyo should you pass:

```bash
--base-url http://deyo.mac-studio
```

- If the user explicitly wants the local/development service as their saved default, use `deyo auth login --api-key '<key>' --base-url http://deyo.mac-studio`.

## Inputs

- Supported link sources are `xiaoyuzhou`, `ximalaya`, `bilibili`, `douyin`, `xiaohongshu`, `youtube`, `apple-podcasts`, and `twitter`.
- Supported local input is one ordinary local audio/video file. Local file transcription is always treated as source `upload`; do not pass `--source` for local files.
- Use a positional local file path:

```bash
deyo ./audio.mp3
```

- Or use explicit file mode:

```bash
deyo --file ./audio.mp3
```

- Use `--mime-type audio/*` or `--mime-type video/*` only when extension-based MIME detection is missing or wrong:

```bash
deyo --file ./audio.mp3 --mime-type audio/mpeg
```

- Use `deyo -- ./audio.mp3` when the single positional input might be parsed as an option.
- Do not pass directories, globs, stdin (`-`), special files, multiple files, batch queues, or resumable-upload expectations. They are not supported.

## Commands

```bash
deyo auth login --api-key '<key>'
deyo auth status
deyo auth logout
deyo [--api-key <key>] [--source <name>] [--file <path>] [--mime-type <type>] [--language <value>] [--format <value>] [--progress-format <value>] [--base-url <url>] [-O <path>] <url-or-file>
```

- Unless the user explicitly requests another result language, pass `--language zh`.
- Add `--source` only when forcing platform detection is useful. Do not force `upload` for local files.
- For agent-run uploads and long-running transcriptions, pass `--progress-format jsonl` and read progress from stderr.

## Output Formats

- `--format` supports `text`, `srt`, `vtt`, `json`, and `verbose_json`.
- If `--format` is omitted, the CLI infers from `-O`: `.srt -> srt`, `.vtt -> vtt`, `.json -> json`, otherwise `text`.
- If `-O` is omitted, the final result is written to stdout. Progress/status always goes to stderr.
- JSON and `verbose_json` results for upload tasks are redacted by the CLI/server so upload hashes, object keys, signed URLs, source URLs, and similar sensitive fields are replaced with `upload:file`.
- Plain-text punctuation and paragraphing are an agent-side post-processing step after you receive plain `text` output. This is not a CLI feature.
- Do not rewrite `srt`, `vtt`, `json`, or `verbose_json` output. Do not rewrite anything when the user asks for raw output. Do not modify a file that the CLI directly wrote with `-O` as the raw requested output.

## Progress Events

- `--progress-format` supports `auto`, `text`, and `jsonl`. `auto` is the default; it refreshes in place on TTY stderr and falls back to text lines on non-TTY stderr. `text` emits text lines. `jsonl` emits one JSON object per stderr line.
- Prefer `--progress-format jsonl` for AI-run jobs. Each stderr line is one JSON event; summarize it to the user instead of pasting raw JSONL.
- Upload events are:
  `upload.hashing`, `upload.started`, `upload.progress`, `upload.completed`, `upload.checking`, `upload.ready`, `upload.failed`, `upload.aborted`.
- Task events are:
  `task.created`, `task.status_changed`, `task.progress`, `task.completed`, `task.failed`, `task.cancelled`, `task.result_written`, `task.notice`.
- Surface these milestones: upload hashing/progress, media inspection, task creation, consumed/remaining minutes when reported, status changes, key transcription progress, completion, failure, cancellation, and output path.
- If `task.created` reports `mode: "subtitles"` or `resultReady: true`, tell the user the source already had usable subtitles and no long paid transcription job is needed.
- If the CLI reports `task.notice` about event stream fallback, continue watching; it falls back to polling.

## Source Boundaries

- YouTube may return direct subtitles. Subtitle-direct tasks have `mode: "subtitles"`, `status: "completed"`, `consumedMinutes: 0`, and do not consume minutes.
- Full link transcription and upload transcription consume minutes after the service creates or reuses a complete transcription job.
- Douyin image/text posts return an unsupported branch, not transcription.
- Xiaohongshu image notes return an unsupported branch, not transcription.
- Twitter/X text or image tweets return an unsupported branch; only video tweets continue to transcription.
- Ximalaya album links return an unsupported branch; ask the user for a concrete episode link. Ximalaya episode pages and `xima.tv` short links are supported.
- Apple Podcasts requires a concrete `podcasts.apple.com` episode link with an `?i=` episode id.
- Bilibili supports normal BV pages, `b23.tv` short links, `player.bilibili.com/player.html` links with `bvid`, and supported `bilibili://video/...` app video links. The CLI passes app links through; Whisper resolves `h5awaken.open_app_url`, base64 `h5awaken`, or a BV path segment. Aid-only/cid-only player links and non-video app links are not supported.

## Recommended Workflow

1. Check `command -v deyo` and `deyo --help`; install or upgrade if needed.
2. Run `deyo auth status`. If no API key is active, ask the user for one and save it with `deyo auth login --api-key '<key>'`.
3. Identify whether the input is a link or one local audio/video file.
4. Choose output path and format. Use `-O` for raw CLI file output; omit `-O` if you need to post-process plain text before presenting it.
5. Use production defaults. Add `--base-url http://deyo.mac-studio` only for explicit local/development requests.
6. Add `--language zh` unless the user requests another language.
7. Add `--progress-format jsonl` for uploads or long tasks.
8. Run the command, monitor stderr events, and relay concise user-facing progress.
9. On completion, provide the output path or transcript. If plain text is being presented in chat, add punctuation and paragraph breaks unless the user asked for raw text.

## Examples

Link transcription with progress and raw text file output:

```bash
deyo --language zh --progress-format jsonl -O ./tmp/transcript.txt 'https://www.youtube.com/watch?v=xxxx'
```

Local file upload transcription:

```bash
deyo --language zh --progress-format jsonl --file ./audio.mp3 --mime-type audio/mpeg -O ./tmp/audio.txt
```

Force YouTube and export SRT:

```bash
deyo --language zh --source youtube --format srt -O ./tmp/out.srt 'https://youtu.be/xxxx'
```

Read JSON from stdout:

```bash
deyo --language zh --format json 'https://www.bilibili.com/video/BVxxxx'
```

Use local/development Deyo only when explicitly requested:

```bash
deyo --base-url http://deyo.mac-studio --language zh --progress-format jsonl -O ./tmp/out.txt 'https://www.youtube.com/watch?v=xxxx'
```

## Troubleshooting

- `deyo: command not found`: install `@casatwy/deyo`.
- Missing `--progress-format`, `--file`, `--mime-type`, or `verbose_json` in help: upgrade the published CLI.
- `缺少 API key。请传 --api-key、设置 DEYO_API_KEY，或先执行 deyo auth login`: ask the user to create an API key, then run `deyo auth login`.
- `API key 无效或不存在`: ask the user to revoke/regenerate a valid key and retry.
- `剩余分钟不足`: the current account needs more minute balance before full transcription can start.
- `本地文件不存在`, directory, glob, stdin, or special-file errors: ask for one concrete ordinary audio/video file path.
- `无法识别本地文件 MIME`: retry with `--mime-type audio/*` or `--mime-type video/*`.
- `分片上传签名已过期` or upload 403: the CLI retries by re-signing parts; if it still fails, retry the command and preserve the raw error.
- `这个文件没有可转写的音频轨`: the media has no decodable audio stream.
- `这个文件暂时不支持转写`: media inspection/ffprobe failed or duration could not be read; ask for another audio/video file.
- If interrupted before upload completion, the CLI may abort the upload. If interrupted after upload completion, during media check, or after task creation, local waiting stops but the server-side upload/check/transcription may continue; this does not cancel the service-side task.
- If a task is created and then appears to finish immediately, check for `mode: "subtitles"` or `resultReady: true` before assuming a long transcription ran.
- If Twitter/X reports no video, explain that text/image tweets are unsupported for transcription.
- If Ximalaya reports an album link, ask for a specific episode link.
