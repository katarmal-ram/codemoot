# CodeMoot v0.2.0 Dogfood Findings

**Date**: 2026-02-11
**Method**: 4-agent parallel dogfood team + 3 GPT debate rounds + manual testing
**Total commands tested**: 17 | **Total tests run**: 50+

## Bugs Found & Fixed

### FIXED: `cost --scope session` returned daily data (Severity: HIGH)
- **Reporter**: ops-tester
- **Issue**: Session scope fell through to daily default, showed wrong `scope` label
- **Fix**: Added session-aware query using `SessionManager.resolveActive()` — commit `ec44fdc`

### FIXED: `--timeout abc` showed raw stack trace (Severity: MEDIUM)
- **Reporter**: manual testing
- **Issue**: Commander option parser threw `Error` instead of `InvalidArgumentError`
- **Fix**: All option validators now use `InvalidArgumentError` — commit `ec44fdc`

### FIXED: `cost --scope session` scope label wrong (Severity: LOW)
- **Reporter**: ops-tester
- **Issue**: Scope label said "last 30 days" regardless of actual scope
- **Fix**: Dynamic scope label based on actual query — commit `ec44fdc`

### FIXED: Job queue race — succeed/fail overwrites canceled (Severity: HIGH)
- **Reporter**: GPT debate round 2
- **Issue**: `succeed()` and `fail()` updated unconditionally, could overwrite `canceled` status
- **Fix**: Added `WHERE status = 'running'` guard — commit `d3a1466`

### FIXED: Watch dedupe key mismatch (Severity: HIGH)
- **Reporter**: GPT debate round 2
- **Issue**: `hasActive('watch-review')` checked literal string but keys are `watch-review:<files>`
- **Fix**: Added `hasActiveByType()` method — commit `d3a1466`

### FIXED: `init --force` merged with existing config (Severity: MEDIUM)
- **Reporter**: GPT debate round 2
- **Issue**: `loadConfig()` always read `.cowork.yml`, so `--force` didn't start clean
- **Fix**: Added `skipFile` option to `loadConfig()` — commit `d3a1466`

### FIXED: Directory input not expanded (Severity: HIGH)
- **Reporter**: GPT debate round 1
- **Issue**: `codemoot review src/` gave "No readable files" because directories aren't files
- **Fix**: Auto-expand directory input to `dir/**/*` glob — commit `5129fc0`

### FIXED: No codex installed → confusing error (Severity: HIGH)
- **Reporter**: GPT debate round 1
- **Issue**: "No codex adapter found in config" when real issue is codex not installed
- **Fix**: Explicit codex detection with install instructions — commit `5129fc0`

### FIXED: No session → unhelpful error (Severity: MEDIUM)
- **Reporter**: GPT debate round 1
- **Issue**: Generic "Session not found" with no guidance
- **Fix**: Suggests `codemoot init` — commit `5129fc0`

## UX Issues (Non-blocking)

### `cost` output is raw JSON only
- No human-readable table format
- Suggested: Add default table view, keep `--json` for machine output
- **Priority**: Low — functional, just not pretty

### `events` JSONL has long response_preview strings
- Wraps badly in terminal
- Suggested: Truncate previews to ~80 chars by default
- **Priority**: Low

## Commands Verified Working

| Command | Status | Notes |
|---------|--------|-------|
| `start` | PASS | First-run concierge works end-to-end |
| `doctor` | PASS | All 6 checks work, correct exit codes |
| `init` | PASS | Creates valid YAML, --force works, preset validation |
| `review` | PASS | File, directory, prompt, diff, preset modes all work |
| `fix --help` | PASS | Options correct |
| `cleanup --help` | PASS | Options correct |
| `plan` | PASS | Requires codex |
| `run` | PASS | Requires codex |
| `debate start/list/status/complete` | PASS | Full lifecycle works |
| `debate turn` | PASS | Codex session resume confirmed |
| `session current/list/status/close` | PASS | All CRUD operations |
| `build list` | PASS | Shows builds |
| `jobs list/status/cancel/retry` | PASS | Error handling clean |
| `shipit --dry-run` | PASS | All 3 profiles (fast/safe/full) |
| `cost` | PASS | All 3 scopes (session/daily/all) |
| `events` | PASS | JSONL output with limit |
| `watch --help` | PASS | Options shown correctly |

## Error Handling Verified

| Scenario | Status |
|----------|--------|
| Missing required argument | PASS — Commander shows usage |
| Invalid option value (--timeout abc) | PASS — Clean error message |
| Invalid preset name | PASS — Lists valid presets |
| Invalid profile name | PASS — Commander shows choices |
| Nonexistent debate/session/job ID | PASS — "Not found" with exit 1 |
| No codex installed | PASS — Install instructions shown |
| No .cowork.yml | PASS — Suggests `codemoot init` |
| Conflicting input modes | PASS — Shows conflict message |
