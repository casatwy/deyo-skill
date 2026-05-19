# Deyo Website

Transform podcast or video to text： [https://deyo.miaobi.fun](https://deyo.miaobi.fun)

# Deyo Skill

[中文版](./README.md)

`deyo` is a skill for **Codex / OpenAI Agents**, **Claude Code**, and **OpenClaw** that tells the agent to use the installed `deyo` CLI for link transcription work instead of the web UI.

It documents how to install the CLI, save an API key once, inspect local auth state, build transcription commands, keep users updated with AI-visible progress, and troubleshoot common failures.

`deyo/SKILL.md` is a shared main definition file that works with Codex / OpenAI Agents, Claude Code, and OpenClaw skill conventions. Only the per-platform metadata under `agents/` is split.

## When To Use

Use this skill when:

- The user wants to install or configure `deyo`
- The user wants to transcribe a link with `deyo`
- The user wants to save an API key once and reuse it later
- The user wants to verify `--source`, `--format`, `-O`, stdout behavior, CLI progress behavior, or chat-visible progress behavior

## Core Rules

- Prefer the installed `deyo` command
- If `deyo` is missing, or `deyo --help` does not list `--progress-format`, install or upgrade the published package `@casatwy/deyo` first
- In production, use the CLI default service URL `https://deyo.miaobi.fun`
- Only pass `--base-url http://deyo.mac-studio` when the user explicitly wants local development
- Never invent an API key; if the user does not provide one, ask them to create it from `/me/api-keys`
- Once the user provides an API key, save it locally with `deyo auth login --api-key '...'`
- Unless the user explicitly requests another output language, default to `--language zh`
- For agent-run transcription tasks that may take more than a moment, default to `--progress-format jsonl`
- Do not dump raw JSONL progress to the user; read it and relay concise status updates instead
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
deyo [--source <name>] [--language <value>] [--format <value>] [--progress-format <value>] [-O <path>] <url>
```

## Output Behavior

- If `-O` is omitted, the final transcript is written to stdout
- If `--format` is omitted, the CLI infers the format from the output file suffix
- `.txt -> text`
- `.srt -> srt`
- `.vtt -> vtt`
- `.json -> json`
- Progress and status messages are written to stderr
- `--progress-format auto` is the default
- With TTY stderr, `auto` keeps the current in-place single-line progress refresh
- With non-TTY stderr, `auto` falls back to line-based text progress so logs and agent output do not get polluted by control characters
- `--progress-format jsonl` emits one JSON object per stderr line and is the preferred mode for AI agents that must keep users updated

## Recommended Workflow

1. Confirm that `deyo` is installed
2. Confirm that `deyo --help` includes `--progress-format`
3. Confirm the target URL, output format, and output path
4. If local auth is missing, ask the user for an API key and run `deyo auth login`
5. Only choose between production and local development when needed
6. Unless the user explicitly asks for another language, add `--language zh`
7. Add `--source` only when forcing a platform is useful
8. For agent-run long tasks, add `--progress-format jsonl`
9. Run the final command and relay task creation, status changes, key progress milestones, and the final outcome to the user

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
- If the user reports missing progress updates, verify that `deyo --help` includes `--progress-format`; if not, upgrade the published CLI first
- If a task ends almost immediately, check whether it was a direct-subtitle-return case rather than a long transcription path
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
