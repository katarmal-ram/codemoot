# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.2.x   | Yes       |
| < 0.2   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in CodeMoot, please report it responsibly:

1. **Do NOT open a public GitHub issue**
2. Use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository
3. Include: description, reproduction steps, impact assessment

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 1 week
- **Fix**: Depending on severity, typically within 2 weeks

## Security Architecture

CodeMoot is a local CLI tool that bridges Claude Code and Codex CLI. Here's how it handles security:

### No API Keys

CodeMoot does **not** manage, store, or transmit API keys. Authentication is handled entirely by Claude Code and Codex CLI themselves — each uses its own legitimate auth mechanism. CodeMoot just spawns them as subprocesses.

### Data Stays Local

- All data (sessions, memory, debates, costs) stored in **local SQLite** — nothing leaves your machine except model prompts sent by the underlying CLI tools
- **No telemetry** — CodeMoot collects zero usage data
- **No network calls** — CodeMoot makes no HTTP requests itself

### DLP Pipeline

A 6-stage data loss prevention pipeline scrubs sensitive content from prompts before they're sent to models:
- Environment variable detection
- Common secret patterns (AWS keys, tokens, passwords)
- Configurable redaction rules

### Input Validation

- **Path traversal prevention**: All file paths are resolved and validated against the project directory
- **Git argument injection prevention**: Diff arguments are validated against a strict character whitelist
- **SQL injection prevention**: All database queries use parameterized statements
- **Shell command safety**: Worker commands are validated, no user-controlled shell interpolation

### Policy Engine

Built-in policy rules that can block risky operations:
- Block commits when CRITICAL findings exist
- Enforce cleanup scans before shipit workflows
- Configurable severity thresholds

## Known Constraints

- Codex CLI manages its own authentication — CodeMoot does not intercept or store credentials
- SQLite databases are not encrypted at rest (use OS-level disk encryption if needed)
- Shell commands in build/shipit profiles execute with your user's permissions
- The cleanup scanner's security scope uses regex pattern matching — it catches common patterns but is not a replacement for a dedicated SAST tool
