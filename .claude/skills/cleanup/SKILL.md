---
name: cleanup
description: Bidirectional AI slop scanner — Claude + GPT independently analyze, then debate disagreements.
user-invocable: true
---

# /cleanup — Bidirectional AI Slop Scanner

## Usage
`/cleanup [scope]` where scope is: deps, unused-exports, hardcoded, duplicates, deadcode, or all

## Description
Claude analyzes independently, then codemoot cleanup runs deterministic regex + GPT scans. 3-way merge with majority-vote confidence.

## Instructions

### Phase 1: Claude Independent Analysis
Scan the codebase yourself using Grep/Glob/Read. For each scope:
- **deps**: Check package.json deps against actual imports
- **unused-exports**: Find exported symbols not imported elsewhere
- **hardcoded**: Magic numbers, URLs, credentials
- **duplicates**: Similar function logic across files
- **deadcode**: Declared but never referenced

Save findings as JSON to a temp file.

### Phase 2: Run codemoot cleanup
```bash
codemoot cleanup --scope SCOPE --host-findings /path/to/claude-findings.json
```

### Phase 3: Present merged results
Show summary: total, high confidence, disputed, adjudicated, by source.

### Phase 4: Rebuttal Round
For Claude/GPT disagreements, optionally debate via `codemoot debate turn`.
