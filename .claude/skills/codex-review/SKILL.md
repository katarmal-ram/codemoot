---
name: codex-review
description: Get an independent GPT review via Codex CLI. Use when you want a second opinion on code, plans, or architecture from a different AI model.
user-invocable: true
---

# /codex-review — Get GPT Review via Codex CLI

## Usage
`/codex-review <file, glob, or description of what to review>`

## Description
Sends content to GPT via `codemoot review` for an independent review with session persistence. GPT has full codebase access and reviews are tracked in SQLite. Uses your ChatGPT subscription — zero API cost.

## Instructions

When the user invokes `/codex-review`, follow these steps:

### Step 1: Gather project context
Before sending to GPT, gather relevant context so GPT understands the project:

1. Check if `CLAUDE.md` or `README.md` exists — read the first 200 lines for project overview
2. Check if `.claude/settings.json` or similar config exists
3. Note the project language, framework, and key patterns

This context will be included in the prompt to reduce false positives.

### Step 2: Determine review mode

**If the user specifies a file or glob:**
```bash
codemoot review <file-or-glob> --focus all
```

**If the user specifies a diff:**
```bash
codemoot review --diff HEAD~3..HEAD
```

**If the user gives a freeform description:**
```bash
codemoot review --prompt "PROJECT CONTEXT: <context from step 1>

REVIEW TASK: <user's description>

Evaluate on: Correctness, Completeness, Quality, Security, Feasibility.
For security findings, verify by reading the actual code before flagging.
Provide SCORE: X/10 and VERDICT: APPROVED or NEEDS_REVISION"
```

**For presets:**
```bash
codemoot review <target> --preset security-audit
codemoot review <target> --preset quick-scan
codemoot review <target> --preset performance
```

### Step 3: Parse and present the output
The command outputs JSON to stdout. Parse it and present as clean markdown:

```
## GPT Review Results

**Score**: X/10 | **Verdict**: APPROVED/NEEDS_REVISION

### Findings
- [CRITICAL] file:line — description
- [WARNING] file:line — description

### GPT's Full Analysis
<review text>

Session: <sessionId> | Tokens: <usage> | Duration: <durationMs>ms
```

### Step 4: If NEEDS_REVISION
Ask if user wants to fix and re-review. If yes:
1. Fix the issues
2. Run `codemoot review` again — session resume gives GPT context of prior review
3. GPT will check if previous issues were addressed

### Important Notes
- **Session resume**: Each review builds on prior context. GPT remembers what it reviewed before.
- **Codebase access**: GPT can read project files during review via codex tools.
- **No arg size limits**: Content is piped via stdin, not passed as CLI args.
- **Presets**: Use --preset for specialized reviews (security-audit, performance, quick-scan, pre-commit, api-review).
- **Background mode**: Add --background to enqueue and continue working.
- **Output capped**: JSON `review` field is capped to 2KB to prevent terminal crashes. Full text is stored in session_events.
- **Progress**: Heartbeat every 60s, throttled to 30s intervals. No agent_message dumps.
