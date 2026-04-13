# Deyo Skill

[中文版](./README.md)

`deyo` is a Codex / OpenAI Agents skill that tells the agent to use the installed `deyo` CLI for link transcription work instead of the web UI.

It documents how to install the CLI, save an API key once, inspect local auth state, build transcription commands, and troubleshoot common failures.

## When To Use

Use this skill when:

- The user wants to install or configure `deyo`
- The user wants to transcribe a link with `deyo`
- The user wants to save an API key once and reuse it later
- The user wants to verify `--source`, `--format`, `-O`, stdout behavior, or progress behavior

## Core Rules

- Prefer the installed `deyo` command
- If `deyo` is missing, install the published package `@casatwy/deyo` first
- In production, use the CLI default service URL `https://deyo.miaobi.fun`
- Only pass `--base-url http://deyo.mac-studio` when the user explicitly wants local development
- Never invent an API key; if the user does not provide one, ask them to create it from `/me/api-keys`
- Once the user provides an API key, save it locally with `deyo auth login --api-key '...'`
- Unless the user explicitly requests another output language, default to `--language zh`

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
deyo [--source <name>] [--language <value>] [--format <value>] [-O <path>] <url>
```

## Output Behavior

- If `-O` is omitted, the final transcript is written to stdout
- If `--format` is omitted, the CLI infers the format from the output file suffix
- `.txt -> text`
- `.srt -> srt`
- `.vtt -> vtt`
- `.json -> json`
- Progress and status messages are written to stderr
- Once the upstream task enters `transcribing`, the CLI refreshes progress in place on a single terminal line

## Recommended Workflow

1. Confirm that `deyo` is installed
2. Confirm the target URL, output format, and output path
3. If local auth is missing, ask the user for an API key and run `deyo auth login`
4. Only choose between production and local development when needed
5. Unless the user explicitly asks for another language, add `--language zh`
6. Add `--source` only when forcing a platform is useful
7. Run the final command

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

Force YouTube and export SRT:

```bash
deyo --language zh --source youtube --format srt -O ./tmp/out.srt 'https://youtu.be/xxxx'
```

Read JSON from stdout:

```bash
deyo --language zh --format json 'https://www.bilibili.com/video/BVxxxx'
```

## Troubleshooting

- `deyo: command not found`: install `@casatwy/deyo` first
- `缺少 API key。请传 --api-key、设置 DEYO_API_KEY，或先执行 deyo auth login`: ask the user to create a key from `/me/api-keys`, then run `deyo auth login`
- `API key 无效或不存在`: ask the user to generate a new valid key
- `剩余分钟不足`: the current account does not have enough minute balance
- If the user reports missing progress updates, verify that they are using the current published CLI and that the task is not a direct-subtitle-return case

## Directory Layout

```text
skill_/
├── README.md
├── README.en.md
└── deyo/
    ├── SKILL.md
    └── agents/
        └── openai.yaml
```

## Related Files

- `deyo/SKILL.md`: main skill definition with usage conditions, rules, and examples
- `deyo/agents/openai.yaml`: OpenAI Agents metadata including display name, short description, and default prompt
