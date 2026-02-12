---
name: plan-review
description: Send execution plans to GPT for structured review via Codex CLI. Use when you have a written plan and want independent validation before implementation.
user-invocable: true
---

# /plan-review — GPT Review of Execution Plans

## Usage
`/plan-review <plan-file-or-description>`

## Description
Sends a Claude-authored execution plan to GPT via `codemoot plan review` for structured critique. GPT returns ISSUE (HIGH/MEDIUM/LOW) and SUGGEST lines with file-level references. Uses session resume for iterative refinement.

## Instructions

When the user invokes `/plan-review`, follow these steps:

### Step 1: Prepare the plan

**If the user provides a file path:**
Use it directly.

**If the user describes what to review:**
1. Write the plan to a temp file (e.g., `/tmp/plan-review.md`)
2. Use that path

**If reviewing the current conversation's plan:**
1. Extract the plan from context
2. Write to a temp file

### Step 2: Run plan review

```bash
cd C:\Users\ramka\Desktop\cowork\codemoot\packages\cli && npx codemoot plan review <plan-file> [options]
```

**Options:**
- `--phase <N>` — Review only a specific phase
- `--build <buildId>` — Link to a build run
- `--timeout <ms>` — Override default timeout (default: 300000)
- `--output <file>` — Save full review to file
- `-` — Read plan from stdin

### Step 3: Parse and present output

The command outputs JSON:
```json
{
  "planFile": "path",
  "verdict": "needs_revision",
  "score": 5,
  "issues": [
    { "severity": "high", "message": "..." },
    { "severity": "medium", "message": "..." }
  ],
  "suggestions": ["..."],
  "review": "truncated to 2KB...",
  "sessionId": "...",
  "usage": { "inputTokens": ..., "outputTokens": ..., "totalTokens": ... }
}
```

Present as:
```
## GPT Plan Review

**Score**: X/10 | **Verdict**: APPROVED/NEEDS_REVISION

### Issues
- [HIGH] description with file references
- [MEDIUM] description

### Suggestions
- suggestion text

Session: <sessionId> | Tokens: <totalTokens> | Duration: <durationMs>ms
```

### Step 4: If NEEDS_REVISION

Ask the user if they want to revise and re-submit:
1. Address the HIGH issues first
2. Revise the plan
3. Write updated plan to the same file
4. Re-run `codemoot plan review` — session resume gives GPT context of prior review

### Important Notes
- **Session resume**: GPT remembers prior reviews via thread resume
- **Codebase access**: GPT reads actual project files to verify plan references
- **Output capped**: JSON `review` field is capped to 2KB. Use `--output` for full text
- **Score-based convergence**: Plans scoring >= 8/10 on 2nd+ iteration auto-converge in `plan generate`
- **Zero API cost**: Uses ChatGPT subscription via Codex CLI
