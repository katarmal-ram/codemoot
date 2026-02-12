---
name: build
description: Autonomous build loop — debate, plan, implement, review, fix — all in one session with GPT review.
user-invocable: true
---

# /build — Autonomous Build Loop

## Usage
`/build <task description>`

## Description
Full pipeline: debate approach with GPT → user approval → implement → GPT review → fix → re-review until approved. SQLite tracking throughout.

## Instructions

### Phase 0: Initialize
1. Record user's exact request (acceptance criteria)
2. `codemoot build start "TASK"`
3. Save buildId and debateId

### Phase 1: Debate the Approach (MANDATORY)
Use /debate protocol. Loop until GPT says STANCE: SUPPORT.
- Gather codebase context first
- Send detailed implementation plan to GPT
- Revise on OPPOSE/UNCERTAIN — never skip

### Phase 1.25: Plan Review (Optional but Recommended)
Before user approval, validate the plan with GPT:
```bash
codemoot plan review /path/to/plan.md --build BUILD_ID
```
GPT reviews the plan against actual codebase, returns ISSUE/SUGGEST lines.
Fix HIGH issues before presenting to user.

### Phase 1.5: User Approval Gate
Present agreed plan. Wait for explicit approval via AskUserQuestion.
```bash
codemoot build event BUILD_ID plan_approved
codemoot debate complete DEBATE_ID
```

### Phase 2: Implement
Write code. Run tests: `pnpm run test`
Never send broken code to review.
```bash
codemoot build event BUILD_ID impl_completed
```

### Phase 3: GPT Review
```bash
codemoot build review BUILD_ID
```
Parse verdict: approved → Phase 4.5, needs_revision → Phase 4

### Phase 4: Fix Issues
Fix every CRITICAL and BUG. Run tests. Back to Phase 3.
```bash
codemoot build event BUILD_ID fix_completed
```

### Phase 4.5: Completeness Check
Compare deliverables against original request. Every requirement must be met.

### Phase 5: Done
```bash
codemoot build status BUILD_ID
```
Present summary with metrics, requirements checklist, GPT verdict.

### Rules
1. NEVER skip debate rounds
2. NEVER skip user approval
3. NEVER declare done without completeness check
4. Run tests after every implementation/fix
5. Zero API cost (ChatGPT subscription)
