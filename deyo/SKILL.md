---
name: deyo
description: Use this skill when the user wants to install, run, or troubleshoot the published `deyo` transcription CLI, including one-time API key login, output file selection, source selection, and progress behavior.
---

# Deyo

Use this skill when work should go through the installed `deyo` command instead of the web UI.

## Use When

- The user wants to install or configure `deyo`.
- The user wants to transcribe a link via `deyo`.
- The user wants to save an API key once with `deyo auth login`.
- The user wants to verify `--source`, `--format`, `-O`, stdout behavior, or CLI progress updates.

## Command Rules

- Prefer the installed `deyo` command.
- If `deyo` is not available, install the published package `@casatwy/deyo` first.
- Always let the CLI use its built-in default base URL; do not override it.
- Never invent an API key. If the user does not provide one, tell them to create it from `https://deyo.miaobi.fun/me/api-keys`.
- Once the user provides an API key, save it locally with `deyo auth login --api-key '...'` so future runs do not need `--api-key`.
- Unless the user explicitly asks for another result language, pass `--language zh`.

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
  `deyo [--source <name>] [--language <value>] [--format <value>] [-O <path>] <url>`

## Output Behavior

- If `-O` is omitted, the final transcript is written to stdout.
- If `--format` is omitted, the CLI infers it from the output file suffix:
  `.txt -> text`, `.srt -> srt`, `.vtt -> vtt`, `.json -> json`
- Progress and status messages are written to stderr.
- Once the upstream task enters `transcribing`, the CLI updates progress in-place on a single terminal line.

## Recommended Workflow

1. Confirm that `deyo` is installed.
2. Confirm the target URL and output format.
3. If local config is missing, ask the user for an API key and run `deyo auth login --api-key '...'`.
4. Unless the user explicitly requested another language, add `--language zh`.
5. Add `--source` only when forcing a platform is useful.
6. Run the command.

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

Force YouTube and export SRT:

```bash
deyo --language zh --source youtube --format srt -O ./tmp/out.srt 'https://youtu.be/xxxx'
```

Read JSON from stdout:

```bash
deyo --language zh --format json 'https://www.bilibili.com/video/BVxxxx'
```

## Troubleshooting

- `deyo: command not found`: install `@casatwy/deyo` first.
- `缺少 API key。请传 --api-key、设置 DEYO_API_KEY，或先执行 deyo auth login`: ask the user to create a key in `/me/api-keys`, then run `deyo auth login`.
- `API key 无效或不存在`: ask the user to create a new key and retry.
- `剩余分钟不足`: the current account needs more minute balance.
- If the user reports no progress updates, verify they are using the current published `deyo` command and that the task is not a subtitle-direct-return case.
