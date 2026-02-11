# CodeMoot

[![CI](https://github.com/katarmal-ram/codemoot/actions/workflows/ci.yml/badge.svg)](https://github.com/katarmal-ram/codemoot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

**A second opinion for AI-generated code.**

CodeMoot is a bridge between [Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code) and [Codex CLI](https://github.com/openai/codex) — two AI models that debate, review, and build code together. One plans, the other critiques, and together they produce better code than either could alone.

> **Built with itself.** Every feature in CodeMoot was coded using CodeMoot — Claude and GPT collaborating to improve their own collaboration tool. Real dogfooding, real multi-model development.

---

## Why CodeMoot?

Most AI coding tools give you **one model's opinion**. But:

- **46% of developers distrust single-model AI output** — bugs, hallucinations, and blind spots are real
- A second model catches what the first one misses — different training data, different strengths
- **No direct competitor** combines debate + consensus + memory + CLI bridging in one open-source tool

CodeMoot makes multi-model collaboration automatic:

- **$0 extra cost** — uses your existing Claude Code and Codex CLI subscriptions, no API keys needed
- **No vendor lock-in** — runs locally, your code never leaves your machine
- **No configuration headache** — if you can run `claude` and `codex` in your terminal, you're ready

---

## Requirements

You need two things installed:

1. **[Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code)** — verify with `claude --version`
2. **[Codex CLI](https://github.com/openai/codex)** — verify with `codex --version`
3. **Node.js >= 22** and **pnpm >= 9**

That's it. CodeMoot handles everything else — structured prompts, session management, token tracking, and result parsing.

---

## Quick Start

```bash
# Install globally
npm install -g @codemoot/cli

# One-command setup — checks prerequisites, creates config, runs a quick review
codemoot start

# Or step by step:
codemoot doctor           # verify claude + codex are working
codemoot init             # create .cowork.yml config
codemoot review src/      # get GPT's independent review of your code
```

After `codemoot init`, you'll have a `.cowork.yml` in your project:

```yaml
models:
  codex-architect:
    provider: openai
    model: gpt-5.3-codex
  codex-reviewer:
    provider: openai
    model: gpt-5.3-codex

roles:
  architect:
    model: codex-architect
  reviewer:
    model: codex-reviewer

workflow: plan-review-implement
mode: autonomous
```

---

## What Can It Do?

### Code Review

Get GPT's independent review of your code — files, freeform prompts, or git diffs.

```bash
codemoot review src/auth.ts                     # Review specific files
codemoot review --prompt "find race conditions"  # GPT explores your codebase with tools
codemoot review --diff HEAD~3..HEAD              # Review recent commits
codemoot review --preset security-audit          # Use a named preset
codemoot review --background src/                # Queue and return immediately
```

**5 built-in presets:** `security-audit`, `performance`, `quick-scan`, `pre-commit`, `api-review`

### Autofix Loop

Review, propose fixes, apply them, re-review — repeat until clean.

```bash
codemoot fix src/                    # Auto-fix loop (default: up to 3 rounds)
codemoot fix src/ --focus security   # Focus on security issues only
codemoot fix --diff HEAD~1..HEAD     # Fix issues in recent changes
codemoot fix src/ --dry-run          # Review only, don't apply fixes
```

### Multi-Model Debate

Claude and GPT debate a topic across multiple rounds with full session persistence.

```bash
codemoot debate start "REST vs GraphQL for our API?"
codemoot debate turn <id> "Consider our mobile client needs"
codemoot debate status <id>          # Current round, verdict, token budget
codemoot debate history <id>         # Full conversation with token tracking
codemoot debate complete <id>        # Mark as resolved
codemoot debate list                 # All debates
```

GPT retains full context across rounds via Codex session resume — no repeated context injection.

### AI Slop Scanner

Parallel deterministic + AI semantic analysis. Both Claude and GPT scan independently, then disputed findings go through per-finding adjudication.

```bash
codemoot cleanup .                          # All 8 scopes
codemoot cleanup . --scope security         # 16 OWASP vulnerability patterns (CWE-mapped)
codemoot cleanup . --scope near-duplicates  # Token 5-gram Jaccard similarity detection
codemoot cleanup . --scope anti-patterns    # 10 code smell detectors
codemoot cleanup . --scope deps             # Unused dependencies
codemoot cleanup . --scope unused-exports   # Dead exports
codemoot cleanup . --scope hardcoded        # Hardcoded secrets/URLs/magic numbers
codemoot cleanup . --scope duplicates       # Exact duplicate functions (MD5 hash)
codemoot cleanup . --scope deadcode         # Unreachable code
codemoot cleanup . --max-disputes 20        # Adjudicate up to 20 disputed findings
codemoot cleanup . --output report.json     # Export findings as JSON
```

**How 3-way merge works:** Deterministic scanners (regex/glob) and Codex (semantic AI) run in parallel. Findings are merged by canonical key. Agreements get boosted confidence. Disputes go through per-finding Codex adjudication with full codebase access.

### Build Automation

Full automated pipeline: debate the approach, plan, implement, review, fix.

```bash
codemoot build start "add user authentication"   # Full pipeline
codemoot build status <id>                        # Current phase + event log
codemoot build review <id>                        # GPT reviews implementation diff
codemoot build list                               # All builds
```

### Shipit (Composite Workflows)

Pre-defined workflow profiles that chain multiple steps.

```bash
codemoot shipit                      # Default: safe profile
codemoot shipit --profile fast       # Review only
codemoot shipit --profile safe       # lint + test + review
codemoot shipit --profile full       # lint + test + review + cleanup + commit
codemoot shipit --dry-run            # Print steps without executing
```

### Watch Mode

Auto-review on file save with coalescing debounce.

```bash
codemoot watch                              # Watch TS/JS files, auto-review on change
codemoot watch --glob "**/*.py"             # Custom glob
codemoot watch --focus security             # Only security reviews
codemoot watch --quiet-ms 800 --cooldown-ms 1500  # Tune debounce timing
```

### Background Jobs

Queue long-running reviews and check results later.

```bash
codemoot review --background src/           # Enqueue and return immediately
codemoot cleanup --background . --scope all # Background cleanup
codemoot jobs list                          # See all jobs
codemoot jobs status <id>                   # Check progress + result
codemoot jobs logs <id>                     # Detailed execution logs
codemoot jobs cancel <id>                   # Cancel queued/running job
codemoot jobs retry <id>                    # Retry a failed job
```

### Session Management

Persistent GPT context across all commands. Sessions track token usage, events, and Codex thread IDs.

```bash
codemoot session start --name "feature-auth"   # Named session
codemoot session current                       # Show active session
codemoot session status <id>                   # Token budget, events, overflow status
codemoot session list                          # All sessions
codemoot session close <id>                    # Close a session
```

### Cost Dashboard

Track token usage across sessions and commands.

```bash
codemoot cost                     # Daily aggregation (last 30 days)
codemoot cost --scope session     # Per-session breakdown
codemoot cost --scope all         # All-time totals
codemoot cost --days 7            # Last 7 days
```

### Events Stream

Real-time JSONL stream of everything happening — useful for editor plugins and monitoring.

```bash
codemoot events                   # Dump all events
codemoot events --follow          # Follow mode (poll for new)
codemoot events --type jobs       # Only job events
codemoot events --type sessions   # Only session events
```

---

## All Commands

| Command | Description |
|---------|-------------|
| `codemoot start` | First-run concierge: verify codex, init config, run quick review |
| `codemoot doctor` | Preflight diagnostics: check codex, config, database, git, node |
| `codemoot init` | Initialize CodeMoot in current project |
| `codemoot install-skills` | Install Claude Code slash commands (/debate, /build, /codex-review, /cleanup) |
| `codemoot review` | Code review via GPT (file, prompt, diff, stdin modes) |
| `codemoot fix` | Autofix loop: review -> apply fixes -> re-review until approved |
| `codemoot cleanup` | AI slop scanner (8 scopes, deterministic + semantic + adjudication) |
| `codemoot plan` | Generate plan via architect + reviewer loop |
| `codemoot run` | Full plan-review-implement cycle |
| `codemoot debate` | Multi-round Claude vs GPT debate with session persistence |
| `codemoot build` | Automated build loop: debate -> plan -> implement -> review -> fix |
| `codemoot shipit` | Composite workflow profiles (fast/safe/full) |
| `codemoot watch` | File watcher with auto-review on change |
| `codemoot session` | Persistent GPT session management |
| `codemoot cost` | Token usage and cost dashboard |
| `codemoot events` | JSONL event stream |
| `codemoot jobs` | Background job queue |

---

## How It Works

```
You (developer)
  |
  v
Claude Code (host AI) -----> CodeMoot CLI -----> Codex CLI (GPT)
  |                            |                     |
  | plans, writes code         | structured prompts  | reviews, critiques
  | manages your project       | session persistence | finds bugs
  |                            | token tracking      | suggests fixes
  v                            | policy enforcement  v
Your codebase                  v                  GPT's analysis
                          SQLite memory           (returned to Claude)
```

1. **Claude Code** is your primary AI — it plans, writes code, manages your project
2. **CodeMoot CLI** bridges them — structured handoff prompts, session resume across rounds, token budget tracking, and policy enforcement
3. **Codex CLI** (GPT) acts as the independent reviewer — reads your codebase via tools, finds bugs, suggests improvements
4. All GPT calls happen via Codex CLI subprocess — **no API keys, no HTTP calls, $0 extra cost**

### Session Resume

CodeMoot uses Codex session resume to maintain GPT context across multiple rounds. In a debate, GPT remembers what was discussed in round 1 when you're in round 5. In a build, the reviewer retains context from the initial review when checking fixes. No repeated context injection, no wasted tokens.

### Handoff Envelope

Every prompt sent to GPT is wrapped in a structured "handoff envelope" with:
- **Preamble**: Codebase access instructions (GPT can `ls`, `cat`, `grep` your project)
- **Resume primer**: If continuing a session, tells GPT not to repeat completed analysis
- **Task**: The actual review/debate/cleanup instruction
- **Constraints**: Focus areas, scope limits
- **Output contract**: Expected response format (VERDICT/SCORE for reviews, FINDING for cleanup)

### Policy Engine

Configurable rules that gate workflows:
- Block commit if any CRITICAL finding exists
- Warn on HIGH findings but allow proceed
- Enforce cleanup before shipit

---

## Architecture

TypeScript monorepo with 3 packages:

| Package | Description | Status |
|---------|-------------|--------|
| `@codemoot/core` | Orchestration engine, memory, models, security, cleanup scanners, policy | Stable |
| `@codemoot/cli` | Command-line interface (17 top-level commands, 40+ subcommands) | Stable |
| `@codemoot/mcp-server` | MCP server (5 tools for IDE integration) | Experimental |

```
packages/
  core/           # Orchestration engine
    src/
      cleanup/    # 8 scanners + 3-way merge + adjudication
      config/     # Config loading, schema validation, presets, ignore
      context/    # Handoff envelope builder
      engine/     # EventBus, StepRunner, LoopController
      memory/     # SQLite stores (sessions, debates, builds, jobs, cache)
      models/     # CliAdapter (Codex bridge), ModelRegistry
      roles/      # Role manager (architect, reviewer)
      security/   # DLP pipeline, canonical retry
      types/      # TypeScript interfaces
      utils/      # Constants, helpers
  cli/            # Commander.js commands
    src/
      commands/   # All CLI command handlers
      watch/      # File watcher + debouncer
  mcp-server/     # MCP protocol server
```

**Stack:** TypeScript (strict ESM), SQLite + FTS5, Commander.js, Vitest, Biome

**47 test files, 628 tests.** All passing.

---

## Claude Code Integration

CodeMoot ships with Claude Code skills that you can install:

```bash
codemoot install-skills
```

This adds slash commands to Claude Code:
- `/debate` — Start a multi-round Claude vs GPT debate
- `/build` — Autonomous build loop with GPT review
- `/codex-review` — Quick GPT second opinion
- `/cleanup` — Bidirectional AI slop scan

---

## `.codemootignore`

Create a `.codemootignore` file in your project root to exclude files from review, cleanup, and watch. Uses gitignore syntax:

```gitignore
# Ignore generated files
dist/
*.min.js
coverage/

# Ignore large data files
*.csv
*.sql

# Ignore vendor code
vendor/
third_party/
```

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed setup instructions.

```bash
git clone https://github.com/katarmal-ram/codemoot.git
cd codemoot
pnpm install
pnpm build
pnpm test         # 628 tests across 47 files
pnpm lint         # Biome linter
pnpm typecheck    # TypeScript strict checks
```

**Roadmap ideas we'd love help with:**
- More model CLIs (Gemini CLI, local models via Ollama)
- Editor plugins (VS Code, Neovim)
- Web dashboard UI
- CI/CD integration (GitHub Actions, GitLab CI)

If you use a different AI CLI tool, open an issue — we'd love to support it.

---

## Support

If CodeMoot saves you time, consider buying me a coffee:

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-yellow.svg)](https://buymeacoffee.com/katarmal.ram)

---

## License

MIT
