---
name: debate
description: Real Claude vs GPT multi-round debate. Use when you need a second opinion, want to debate architecture decisions, or evaluate competing approaches with multi-model collaboration.
user-invocable: true
---

# /debate — Real Claude vs GPT Multi-Round Debate

## Usage
`/debate <topic or question>`

## Description
Enters a structured debate mode where Claude (you) and GPT (via Codex CLI) take opposing or complementary stances on a topic. Claude proposes, GPT critiques, Claude revises, GPT re-evaluates — looping until both models converge on an answer or max rounds are reached. This is real multi-model collaboration, not GPT talking to itself.

**Backend**: All GPT calls go through `codemoot debate` CLI commands which use `callWithResume()` for session persistence, SQLite `debate_turns` table for crash recovery, and JSONL parsing for real token usage tracking.

## Instructions

When the user invokes `/debate`, follow this protocol exactly:

### Phase 0: Setup

1. Parse the debate topic from the user's message
2. Start the debate via the backend:

```bash
cd C:\Users\ramka\Desktop\cowork\codemoot && node packages/cli/dist/index.js debate start "TOPIC_HERE" --max-rounds 5
```

This returns JSON:
```json
{
  "debateId": "abc123",
  "topic": "...",
  "maxRounds": 5,
  "status": "started"
}
```

3. Save the `debateId` — you'll use it for every subsequent turn.
4. Announce entering debate mode:
   ```
   Entering debate mode: Claude vs GPT
   Topic: <topic>
   Debate ID: <debateId>
   Max rounds: 5 (or until convergence)
   ```
5. Set round counter to 1

### Phase 1: Claude's Opening Proposal (Round 1)

Think deeply about the topic. Generate your genuine proposal/plan/answer. This should be your REAL thinking — not a placeholder. Be thorough and specific.

Format your proposal clearly under a header:
```
## Claude's Proposal (Round 1)
<your thorough proposal>

STANCE: SUPPORT
```

### Phase 1.5: Gather Codebase Context (if relevant)

Before sending to GPT, if the debate topic relates to the codebase, gather relevant context:
- Use `Grep`, `Glob`, `Read` to find relevant files
- Summarize the key files, architecture, and patterns GPT should know about
- Include this as CODEBASE CONTEXT in the prompt to GPT

This is critical: **GPT now runs in the project directory and can read files**, but giving it a head start with relevant context makes the debate much more productive.

### Phase 2: Send to GPT for Critique

Call the backend to send your proposal to GPT with session resume:

```bash
cd C:\Users\ramka\Desktop\cowork\codemoot && node packages/cli/dist/index.js debate turn DEBATE_ID "You are a senior technical reviewer debating with another AI (Claude) about a codebase. You have full access to the project files — use tools to read code, check structure, and verify claims. Ground your critique in the actual code, not assumptions.

DEBATE TOPIC: <topic>

CODEBASE CONTEXT (key files relevant to this discussion):
<summarize relevant files, architecture, patterns — gathered in Phase 1.5>

CLAUDE'S PROPOSAL:
<your proposal text>

Respond with:
1. What you agree with (be specific)
2. What you disagree with or find weak (be specific)
3. Your suggested improvements or alternative approach
4. End with exactly one of:
   - STANCE: SUPPORT (if you broadly agree, minor tweaks only)
   - STANCE: OPPOSE (if you have significant concerns)
   - STANCE: UNCERTAIN (if mixed)" --round 1
```

This returns JSON:
```json
{
  "debateId": "abc123",
  "round": 1,
  "response": "GPT's full response text...",
  "sessionId": "thread-xyz",
  "resumed": false,
  "usage": { "inputTokens": 100, "outputTokens": 50, ... },
  "durationMs": 5000
}
```

Present GPT's critique clearly:
```
## GPT's Critique (Round 1)
<GPT's response from the JSON>

Session: <sessionId> | Tokens: <usage> | Duration: <durationMs>ms
```

### Phase 3: Check Convergence

After each GPT response, check:
- If GPT says **STANCE: SUPPORT** → convergence reached, go to Phase 5
- If round >= max rounds → max rounds reached, go to Phase 5
- Otherwise → continue to Phase 4

### Phase 4: Claude's Revision

Read GPT's critique carefully. Think about each point genuinely:
- Where is GPT right? Incorporate those changes.
- Where is GPT wrong? Explain why with evidence.
- Where are you uncertain? Acknowledge it.

Write your revised proposal. Increment round counter.

Format:
```
## Claude's Revision (Round <N>)
<your revised proposal addressing GPT's points>

STANCE: <SUPPORT/OPPOSE/UNCERTAIN>
```

Then send the revision back to GPT using the backend (session resume happens automatically):

```bash
cd C:\Users\ramka\Desktop\cowork\codemoot && node packages/cli/dist/index.js debate turn DEBATE_ID "The other AI (Claude) has revised their proposal based on your critique.

CLAUDE'S REVISION (Round <N>):
<your revised text>

Evaluate this revision:
1. Were your previous concerns addressed?
2. Any new concerns?
3. What remains unresolved?
4. End with STANCE: SUPPORT, OPPOSE, or UNCERTAIN" --round N
```

Go back to Phase 3.

### Phase 5: Final Synthesis

When the debate ends (convergence or max rounds), mark it complete:

```bash
cd C:\Users\ramka\Desktop\cowork\codemoot && node packages/cli/dist/index.js debate complete DEBATE_ID
```

Then synthesize the final answer:

```
## Debate Concluded
Rounds: <N>
Convergence: <Yes/No>
Debate ID: <debateId>

## Final Agreed Position
<Synthesize the best of both Claude and GPT's positions>

## Key Agreements
- <bullet points of what both agreed on>

## Remaining Disagreements (if any)
- <bullet points where they differed>

## Debate Stats
- Rounds: <N>
- Claude stances: <list>
- GPT stances: <list>
- Session resume: <resumed count> / <total turns>
```

Optionally check full debate status:
```bash
cd C:\Users\ramka\Desktop\cowork\codemoot && node packages/cli/dist/index.js debate status DEBATE_ID
```

### Important Rules

1. **Be genuine** — Don't just agree with GPT to end the debate. If you think GPT is wrong, say so and explain why. The value is in real disagreement.
2. **Session resume is automatic** — The `codemoot debate turn` command handles session resume internally via `callWithResume()`. If resume fails, it falls back to a fresh codex exec automatically. You don't need to manage thread IDs.
3. **State is persisted** — Every turn is saved to SQLite `debate_turns` table. If the session crashes, the debate can be resumed later.
4. **Respect the user** — After the debate concludes, ask the user if they want to act on the conclusion, continue debating, or take a different direction.
5. **Cost** — All codex calls use the user's ChatGPT subscription. Zero API cost. Session resume gives ~87% token caching.
6. **Timeout** — Each turn has a 120s default timeout. Use `--timeout` to override.
7. **Parse JSON output** — All `codemoot debate` commands output JSON. Parse it to extract the response text, session info, and usage stats. The `response` field is capped to 2KB; check `responseTruncated` boolean.
8. **Progress** — Heartbeat every 60s, progress throttled to 30s intervals.
