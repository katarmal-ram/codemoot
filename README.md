# CodeMoot

[![CI](https://github.com/katarmal-ram/codemoot/actions/workflows/ci.yml/badge.svg)](https://github.com/katarmal-ram/codemoot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A second opinion for AI-generated code.** Claude Code + Codex CLI collaboration platform that brings debate, review, autofix, and consensus patterns to your development workflow.

CodeMoot bridges Claude and GPT so they work as partners — one plans, the other reviews, and together they build better code than either could alone.

## Quick Start

```bash
# Install globally
npm install -g @codemoot/cli

# One-command setup: verifies codex, creates config, runs first review
codemoot start

# Or step by step:
codemoot doctor           # check prerequisites
codemoot init             # create .cowork.yml
codemoot review src/      # review code with GPT
codemoot fix src/         # autofix loop: review → fix → re-review

# Debate architecture with GPT
codemoot debate start "Should we use REST or GraphQL?"

# Ship with confidence
codemoot shipit --profile safe
```

## Prerequisites

- Node.js >= 20
- [Codex CLI](https://github.com/openai/codex) installed (`npm install -g @openai/codex`)
- ChatGPT subscription (Codex CLI uses your existing subscription — $0 API cost)

## Commands

### Getting Started

| Command | Description |
|---------|-------------|
| `codemoot start` | First-run concierge: verify codex, init config, run quick review |
| `codemoot doctor` | Preflight diagnostics: check codex, config, database, git, node |
| `codemoot init` | Initialize CodeMoot in current project |

### Core Workflows

| Command | Description |
|---------|-------------|
| `codemoot review <file>` | Code review via GPT with structured findings |
| `codemoot review --prompt "..."` | Freeform review — GPT explores codebase via tools |
| `codemoot review --diff HEAD~3..HEAD` | Review git changes |
| `codemoot review --preset security-audit` | Use named preset (5 built-in) |
| `codemoot fix <file>` | Autofix loop: review → apply fixes → re-review |
| `codemoot cleanup [path]` | Scan for unused deps, dead code, duplicates, hardcoded values |
| `codemoot plan <task>` | Generate plan via architect + reviewer loop |
| `codemoot run <task>` | Full plan-review-implement cycle |

### Multi-Model Debate

| Command | Description |
|---------|-------------|
| `codemoot debate start <topic>` | Start a Claude vs GPT debate |
| `codemoot debate turn <id> <prompt>` | Send next prompt with session resume |
| `codemoot debate status <id>` | Show debate progress |
| `codemoot debate list` | List all debates |
| `codemoot debate history <id>` | Full message history |
| `codemoot debate complete <id>` | Mark debate as done |

### Automation

| Command | Description |
|---------|-------------|
| `codemoot shipit [--profile fast\|safe\|full]` | Composite workflow: lint → test → review → cleanup → commit |
| `codemoot watch` | Watch files, auto-enqueue reviews on save |
| `codemoot build start <task>` | Automated build loop with GPT review |

### Background Jobs

| Command | Description |
|---------|-------------|
| `codemoot review --background` | Enqueue review, return immediately |
| `codemoot jobs list` | List background jobs |
| `codemoot jobs status <id>` | Job details with logs |
| `codemoot jobs logs <id>` | Full job log output |
| `codemoot jobs cancel <id>` | Cancel a job |
| `codemoot jobs retry <id>` | Retry a failed job |

### Session Management

| Command | Description |
|---------|-------------|
| `codemoot session start` | Start new persistent GPT session |
| `codemoot session current` | Show active session with token budget |
| `codemoot session list` | List all sessions |
| `codemoot session close <id>` | Close a session |

### Observability

| Command | Description |
|---------|-------------|
| `codemoot cost` | Token usage dashboard (by command, by day) |
| `codemoot events --follow` | Stream events as JSONL (for editors/CI) |

## Review Presets

| Preset | Focus | Timeout | Use Case |
|--------|-------|---------|----------|
| `security-audit` | Injection, auth, secrets | 1200s | Pre-deploy security scan |
| `performance` | N+1, memory, blocking | 900s | Performance optimization |
| `quick-scan` | Top bugs only | 240s | Quick sanity check |
| `pre-commit` | Changed code blockers | 180s | Git pre-commit hook |
| `api-review` | Contracts, versioning | 900s | API design review |

## Shipit Profiles

| Profile | Steps | Use Case |
|---------|-------|----------|
| `fast` | review | Quick check before push |
| `safe` | lint → test → review → cleanup | Default — catches most issues |
| `full` | lint → test → review → cleanup → commit | Full pipeline with auto-commit |

## Policy Engine

CodeMoot includes a built-in policy engine that gates actions:

- **Block on CRITICAL**: Any critical finding blocks the commit
- **Warn on NEEDS_REVISION**: Review verdict triggers a warning
- Custom rules via predicate-based engine (enforce/warn modes)

## Architecture

TypeScript monorepo with 3 packages:

| Package | Description | Status |
|---------|-------------|--------|
| `@codemoot/core` | Orchestration engine, memory, policy, caching | Stable |
| `@codemoot/cli` | Command-line interface (15 commands) | Stable |
| `@codemoot/mcp-server` | MCP server (5 tools for IDE integration) | Experimental |

### How It Works

1. **Claude Code** is your primary AI — it plans, writes code, manages your project
2. **Codex CLI** (GPT) acts as reviewer/critic — it reads your codebase, finds bugs, suggests fixes
3. **CodeMoot** bridges them — structured prompts, session persistence, token tracking, policy gates

All GPT calls happen via Codex CLI using your ChatGPT subscription — **$0 API cost**.

## Configuration

`.cowork.yml` in your project root:

```yaml
models:
  codex-architect:
    provider: openai
    model: gpt-5.3-codex
    providerMode: cli
  codex-reviewer:
    provider: openai
    model: gpt-5.3-codex
    providerMode: cli

roles:
  architect:
    model: codex-architect
  reviewer:
    model: codex-reviewer

workflow: plan-review-implement
mode: autonomous
```

### `.codemootignore`

Exclude files from review/cleanup/watch (gitignore syntax):

```
node_modules
dist
*.db
.env
```

## MCP Server (Experimental)

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "codemoot": {
      "command": "npx",
      "args": ["@codemoot/mcp-server"],
      "env": {
        "CODEMOOT_PROJECT_DIR": "/path/to/your/project"
      }
    }
  }
}
```

Tools: `codemoot_review`, `codemoot_plan`, `codemoot_debate`, `codemoot_memory`, `codemoot_cost`

## Development

```bash
git clone https://github.com/katarmal-ram/codemoot.git
cd codemoot
pnpm install
pnpm build
pnpm test         # 656 tests across 48 files
pnpm lint         # Biome linter
pnpm typecheck    # TypeScript strict checks
```

## Known Limitations (v0.2.0)

- Background job worker must be started manually (auto-spawn coming)
- Watch mode enqueues jobs but requires worker process
- MCP server is experimental — core + CLI are stable
- Autofix loop depends on GPT's ability to apply edits via Codex tools
- Windows path normalization may have edge cases

## License

MIT
