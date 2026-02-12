# CodeMoot Dogfood Log — Launch Sprint (2026-02-11)

## Test Matrix

| Command | Status | Notes |
|---------|--------|-------|
| `codemoot --help` | PASS | All 15 commands listed |
| `codemoot --version` | PASS | Returns 0.2.0 |
| `codemoot init` | PASS | Previously tested |
| `codemoot run <task>` | PASS | Previously tested (requires codex) |
| `codemoot plan <task>` | PASS | Previously tested (requires codex) |
| `codemoot review <file>` | PASS | Previously tested (requires codex) |
| `codemoot review --prompt` | PASS | Tested in handoff envelope dogfood |
| `codemoot review --diff` | PASS | Previously tested |
| `codemoot review --background` | PASS | Enqueues job, returns jobId |
| `codemoot review --preset` | PASS | Registered, preset validation works |
| `codemoot cleanup` | PASS | Previously tested (requires codex) |
| `codemoot cleanup --background` | PASS | Registered, enqueue path works |
| `codemoot debate start` | PASS | 17 debates in DB |
| `codemoot debate turn` | PASS | Session resume confirmed working |
| `codemoot debate list` | PASS | Returns all 17 debates |
| `codemoot debate status` | PASS | Previously tested |
| `codemoot debate history` | PASS | Previously tested |
| `codemoot debate complete` | PASS | Previously tested |
| `codemoot build start` | PASS | Previously tested (requires codex) |
| `codemoot build status` | PASS | Previously tested |
| `codemoot build list` | PASS | Previously tested |
| `codemoot session start` | PASS | Creates session in DB |
| `codemoot session current` | PASS | Shows active session, token budget |
| `codemoot session list` | PASS | Lists 6 sessions |
| `codemoot session status` | PASS | Shows events and thread info |
| `codemoot session close` | PASS | Previously tested |
| `codemoot jobs list` | PASS | Shows 1 job (canceled) |
| `codemoot jobs status <id>` | PASS | Shows full job details with payload |
| `codemoot jobs logs <id>` | PASS | Returns empty logs (no worker ran) |
| `codemoot jobs cancel <id>` | PASS | Cancels queued job |
| `codemoot jobs retry` | N/T | Needs failed job to test |
| `codemoot watch` | N/T | Requires running watcher process |
| `codemoot events` | PASS | Returns session_events as JSONL |
| `codemoot cost` | PASS | Shows 24 calls, 29.9M tokens, by-command breakdown |
| `codemoot shipit --dry-run` | PASS | Shows 4 steps, all skipped, policy=allow |
| `codemoot fix` | N/T | Requires codex for live test |

## Bugs Found

1. **Session 3030% utilization**: `maxContext` was 128K from old sessions (pre-M1 fix). Fixed: treat 128K as stale default, use 400K.
2. **Pre-existing typecheck errors**: build.ts, debate.ts, review.ts, utils.ts had TS errors before sprint (tsup ignores them). Fixing in parallel.

## Fixes Applied

1. M1: toSession 400K fallback + real token usage
2. M2: Background job queue + CLI commands
3. M3: Watch mode + events stream
4. M4: Review presets + cache + cost dashboard
5. M5: Shipit + policy engine
6. Autofix loop (`codemoot fix`)
7. Session 128K → 400K migration guard

## Known Issues (Launch)

- Background job worker process not implemented yet (jobs enqueue but don't execute)
- Watch mode enqueues but worker needed to process
- Pre-existing typecheck errors in build.ts/debate.ts (being fixed)
- MCP server marked experimental
- Autofix loop quality depends on GPT's tool-use capability
