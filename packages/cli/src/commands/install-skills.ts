// packages/cli/src/commands/install-skills.ts — Install Claude Code skills, agents, hooks, and CLAUDE.md into current project

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import chalk from 'chalk';

interface InstallOptions {
  force: boolean;
}

interface SkillFile {
  path: string;
  content: string;
  description: string;
}

const SKILLS: SkillFile[] = [
  {
    path: '.claude/skills/codex-review/SKILL.md',
    description: '/codex-review — Get GPT review via Codex CLI',
    content: `---
name: codex-review
description: Get an independent GPT review via Codex CLI. Use when you want a second opinion on code, plans, or architecture from a different AI model.
user-invocable: true
---

# /codex-review — Get GPT Review via Codex CLI

## Usage
\`/codex-review <file, glob, or description of what to review>\`

## Description
Sends content to GPT via \`codemoot review\` for an independent review with session persistence. GPT has full codebase access and reviews are tracked in SQLite. Uses your ChatGPT subscription — zero API cost.

## Instructions

When the user invokes \`/codex-review\`, follow these steps:

### Step 1: Gather project context
Before sending to GPT, gather relevant context so GPT understands the project:

1. Check if \`CLAUDE.md\` or \`README.md\` exists — read the first 200 lines for project overview
2. Check if \`.claude/settings.json\` or similar config exists
3. Note the project language, framework, and key patterns

This context will be included in the prompt to reduce false positives.

### Step 2: Determine review mode

**If the user specifies a file or glob:**
\`\`\`bash
codemoot review <file-or-glob> --focus all
\`\`\`

**If the user specifies a diff:**
\`\`\`bash
codemoot review --diff HEAD~3..HEAD
\`\`\`

**If the user gives a freeform description:**
\`\`\`bash
codemoot review --prompt "PROJECT CONTEXT: <context from step 1>

REVIEW TASK: <user's description>

Evaluate on: Correctness, Completeness, Quality, Security, Feasibility.
For security findings, verify by reading the actual code before flagging.
Provide SCORE: X/10 and VERDICT: APPROVED or NEEDS_REVISION"
\`\`\`

**For presets:**
\`\`\`bash
codemoot review <target> --preset security-audit
codemoot review <target> --preset quick-scan
codemoot review <target> --preset performance
\`\`\`

### Step 3: Parse and present the output
The command outputs JSON to stdout. Parse it and present as clean markdown:

\`\`\`
## GPT Review Results

**Score**: X/10 | **Verdict**: APPROVED/NEEDS_REVISION

### Findings
- [CRITICAL] file:line — description
- [WARNING] file:line — description

### GPT's Full Analysis
<review text>

Session: <sessionId> | Tokens: <usage> | Duration: <durationMs>ms
\`\`\`

### Step 4: If NEEDS_REVISION
Ask if user wants to fix and re-review. If yes:
1. Fix the issues
2. Run \`codemoot review\` again — session resume gives GPT context of prior review
3. GPT will check if previous issues were addressed

### Important Notes
- **Session resume**: Each review builds on prior context. GPT remembers what it reviewed before.
- **Codebase access**: GPT can read project files during review via codex tools.
- **No arg size limits**: Content is piped via stdin, not passed as CLI args.
- **Presets**: Use --preset for specialized reviews (security-audit, performance, quick-scan, pre-commit, api-review).
- **Background mode**: Add --background to enqueue and continue working.
- **Output capped**: JSON \`review\` field is capped to 2KB to prevent terminal crashes. Full text is stored in session_events.
- **Progress**: Heartbeat every 60s, throttled to 30s intervals. No agent_message dumps.
`,
  },
  {
    path: '.claude/skills/plan-review/SKILL.md',
    description: '/plan-review — GPT review of execution plans',
    content: `---
name: plan-review
description: Send execution plans to GPT for structured review via Codex CLI. Use when you have a written plan and want independent validation before implementation.
user-invocable: true
---

# /plan-review — GPT Review of Execution Plans

## Usage
\`/plan-review <plan-file-or-description>\`

## Description
Sends a Claude-authored execution plan to GPT via \`codemoot plan review\` for structured critique. GPT returns ISSUE (HIGH/MEDIUM/LOW) and SUGGEST lines with file-level references.

## Instructions

### Step 1: Prepare the plan
- If the user provides a file path, use it directly
- If reviewing the current conversation's plan, write to a temp file first

### Step 2: Run plan review
\`\`\`bash
codemoot plan review <plan-file> [--phase N] [--build BUILD_ID] [--timeout ms] [--output file]
\`\`\`

### Step 3: Parse and present output
JSON output includes: \`verdict\`, \`score\`, \`issues[]\` (severity + message), \`suggestions[]\`.

Present as:
\`\`\`
## GPT Plan Review
**Score**: X/10 | **Verdict**: APPROVED/NEEDS_REVISION
### Issues
- [HIGH] description
### Suggestions
- suggestion text
\`\`\`

### Step 4: If NEEDS_REVISION
Fix HIGH issues, revise the plan, re-run. Session resume gives GPT context of prior review.

### Important Notes
- **Session resume**: GPT remembers prior reviews via thread resume
- **Codebase access**: GPT reads actual project files to verify plan references
- **Output capped**: JSON \`review\` field is capped to 2KB. Use \`--output\` for full text
- **Zero API cost**: Uses ChatGPT subscription via Codex CLI
`,
  },
  {
    path: '.claude/skills/debate/SKILL.md',
    description: '/debate — Claude vs GPT multi-round debate',
    content: `---
name: debate
description: Real Claude vs GPT multi-round debate. Use when you need a second opinion, want to debate architecture decisions, or evaluate competing approaches.
user-invocable: true
---

# /debate — Real Claude vs GPT Multi-Round Debate

## Usage
\`/debate <topic or question>\`

## Description
Structured debate: Claude proposes, GPT critiques, Claude revises, GPT re-evaluates — looping until convergence or max rounds. Real multi-model collaboration via codemoot CLI with session persistence.

## Instructions

### Phase 0: Setup
1. Parse topic from user's message
2. Start debate:
\`\`\`bash
codemoot debate start "TOPIC_HERE"
\`\`\`
3. Save the \`debateId\` from JSON output
4. Announce: "Entering debate mode: Claude vs GPT"

### Phase 1: Claude's Opening Proposal
Think deeply. Generate your genuine proposal. Be thorough and specific.

### Phase 1.5: Gather Codebase Context
If topic relates to code, use Grep/Glob/Read to find relevant files. Summarize for GPT.

### Phase 2: Send to GPT
\`\`\`bash
codemoot debate turn DEBATE_ID "You are a senior technical reviewer debating with Claude about a codebase. You have full access to project files.

DEBATE TOPIC: <topic>
CODEBASE CONTEXT: <summary>
CLAUDE'S PROPOSAL: <proposal>

Respond with:
1. What you agree with
2. What you disagree with
3. Suggested improvements
4. STANCE: SUPPORT, OPPOSE, or UNCERTAIN" --round N
\`\`\`

### Phase 3: Check Convergence
- STANCE: SUPPORT → go to Phase 5
- Max rounds reached → go to Phase 5
- Otherwise → Phase 4

### Phase 4: Claude's Revision
Read GPT's critique. Revise genuinely. Send back to GPT.

### Phase 5: Final Synthesis
\`\`\`bash
codemoot debate complete DEBATE_ID
\`\`\`
Present: final position, agreements, disagreements, stats.

### Rules
1. Be genuine — don't just agree to end the debate
2. Session resume is automatic via callWithResume()
3. State persisted to SQLite
4. Zero API cost (ChatGPT subscription)
5. 600s default timeout per turn
6. JSON \`response\` field capped to 2KB — check \`responseTruncated\` boolean
7. Progress heartbeat every 60s, throttled to 30s intervals
`,
  },
  {
    path: '.claude/skills/build/SKILL.md',
    description: '/build — Autonomous build loop with GPT review',
    content: `---
name: build
description: Autonomous build loop — debate, plan, implement, review, fix — all in one session with GPT review.
user-invocable: true
---

# /build — Autonomous Build Loop

## Usage
\`/build <task description>\`

## Description
Full pipeline: debate approach with GPT → user approval → implement → GPT review → fix → re-review until approved. SQLite tracking throughout.

## Instructions

### Phase 0: Initialize
1. Record user's exact request (acceptance criteria)
2. \`codemoot build start "TASK"\`
3. Save buildId and debateId

### Phase 1: Debate the Approach (MANDATORY)
Use /debate protocol. Loop until GPT says STANCE: SUPPORT.
- Gather codebase context first
- Send detailed implementation plan to GPT
- Revise on OPPOSE/UNCERTAIN — never skip

### Phase 1.25: Plan Review (Recommended)
Before user approval, validate the plan with GPT:
\`\`\`bash
codemoot plan review /path/to/plan.md --build BUILD_ID
\`\`\`
GPT reviews the plan against actual codebase, returns ISSUE/SUGGEST lines.
Fix HIGH issues before presenting to user.

### Phase 1.5: User Approval Gate
Present agreed plan. Wait for explicit approval via AskUserQuestion.
\`\`\`bash
codemoot build event BUILD_ID plan_approved
codemoot debate complete DEBATE_ID
\`\`\`

### Phase 2: Implement
Write code. Run tests: \`pnpm run test\`
Never send broken code to review.
\`\`\`bash
codemoot build event BUILD_ID impl_completed
\`\`\`

### Phase 3: GPT Review
\`\`\`bash
codemoot build review BUILD_ID
\`\`\`
Parse verdict: approved → Phase 4.5, needs_revision → Phase 4

### Phase 4: Fix Issues
Fix every CRITICAL and BUG. Run tests. Back to Phase 3.
\`\`\`bash
codemoot build event BUILD_ID fix_completed
\`\`\`

### Phase 4.5: Completeness Check
Compare deliverables against original request. Every requirement must be met.

### Phase 5: Done
\`\`\`bash
codemoot build status BUILD_ID
\`\`\`
Present summary with metrics, requirements checklist, GPT verdict.

### Rules
1. NEVER skip debate rounds
2. NEVER skip user approval
3. NEVER declare done without completeness check
4. Run tests after every implementation/fix
5. Zero API cost (ChatGPT subscription)
`,
  },
  {
    path: '.claude/skills/cleanup/SKILL.md',
    description: '/cleanup — Bidirectional AI slop scanner',
    content: `---
name: cleanup
description: Bidirectional AI slop scanner — Claude + GPT independently analyze, then debate disagreements.
user-invocable: true
---

# /cleanup — Bidirectional AI Slop Scanner

## Usage
\`/cleanup [scope]\` where scope is: deps, unused-exports, hardcoded, duplicates, deadcode, or all

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
\`\`\`bash
codemoot cleanup --scope SCOPE --host-findings /path/to/claude-findings.json
\`\`\`

### Phase 3: Present merged results
Show summary: total, high confidence, disputed, adjudicated, by source.

### Phase 4: Rebuttal Round
For Claude/GPT disagreements, optionally debate via \`codemoot debate turn\`.
`,
  },
  {
    path: '.claude/agents/codex-liaison.md',
    description: 'Codex Liaison agent — iterates with GPT until 9.5/10',
    content: `# Codex Liaison Agent

## Role
Specialized teammate that communicates with GPT via codemoot CLI to get independent reviews and iterate until quality threshold is met.

## How You Work
1. Send content to GPT via \`codemoot review\` or \`codemoot plan review\`
2. Parse JSON output for score, verdict, findings
3. If NEEDS_REVISION: fix issues and re-submit (session resume retains context)
4. Loop until APPROVED or max iterations
5. Report final version back to team lead

## Available Commands
\`\`\`bash
codemoot review <file-or-glob>           # Code review
codemoot review --diff HEAD~3..HEAD      # Diff review
codemoot plan review <plan-file>         # Plan review
codemoot debate turn DEBATE_ID "prompt"  # Debate turn
codemoot fix <file-or-glob>              # Autofix loop
\`\`\`

## Important Rules
- NEVER fabricate GPT's responses — always parse actual JSON output
- NEVER skip iterations if GPT says NEEDS_REVISION
- Use your own judgment when GPT's feedback conflicts with project requirements
- JSON \`review\`/\`response\` fields are capped to 2KB; use \`--output\` for full text
- All commands use session resume — GPT retains context across calls
- Zero API cost (ChatGPT subscription via Codex CLI)
`,
  },
];

const CLAUDE_MD_SECTION = `
## CodeMoot — Multi-Model Collaboration

This project uses [CodeMoot](https://github.com/katarmal-ram/codemoot) for Claude + GPT collaboration. CodeMoot bridges Claude Code and Codex CLI so they work as partners — one plans, the other reviews.

### How Sessions Work
- Every \`codemoot\` command uses a **unified session** with GPT via Codex CLI
- Sessions persist across commands — GPT remembers prior reviews, debates, and fixes
- Sessions are stored in \`.cowork/db/cowork.db\` (SQLite)
- When a session's token budget fills up, it auto-rolls to a new thread
- Run \`codemoot session current\` to see the active session

### Available Commands (use these, not raw codex)
- \`codemoot review <file-or-dir>\` — GPT reviews code with codebase access
- \`codemoot review --prompt "question"\` — GPT explores codebase to answer
- \`codemoot review --diff HEAD~3..HEAD\` — Review git changes
- \`codemoot review --preset security-audit\` — Specialized review presets
- \`codemoot fix <file>\` — Autofix loop: review → apply fixes → re-review
- \`codemoot debate start "topic"\` — Multi-round Claude vs GPT debate
- \`codemoot cleanup\` — Scan for unused deps, dead code, duplicates
- \`codemoot plan generate "task"\` — Generate plans via multi-model loop
- \`codemoot plan review <plan-file>\` — GPT review of execution plans
- \`codemoot shipit --profile safe\` — Composite workflow (lint+test+review)
- \`codemoot cost\` — Token usage dashboard
- \`codemoot doctor\` — Check prerequisites

### Slash Commands
- \`/codex-review\` — Quick GPT review (uses codemoot review internally)
- \`/debate\` — Start a Claude vs GPT debate
- \`/plan-review\` — GPT review of execution plans
- \`/build\` — Full build loop: debate → plan → implement → GPT review → fix
- \`/cleanup\` — Bidirectional AI slop scanner

### When to Use CodeMoot
- After implementing a feature → \`codemoot review src/\`
- Before committing → \`codemoot review --diff HEAD --preset pre-commit\`
- Architecture decisions → \`/debate "REST vs GraphQL?"\`
- Full feature build → \`/build "add user authentication"\`
- After shipping → \`codemoot shipit --profile safe\`

### Session Tips
- Sessions auto-resume — GPT retains context from prior commands
- \`codemoot session list\` shows all sessions with token usage
- \`codemoot cost --scope session\` shows current session spend
- Start fresh with \`codemoot session start --name "new-feature"\`
`;

const HOOKS_CONFIG = {
  hooks: {
    PostToolUse: [
      {
        matcher: 'Bash',
        pattern: 'git commit',
        command: 'echo "Tip: Run codemoot review --diff HEAD~1 for a GPT review of this commit"',
      },
    ],
  },
};

export async function installSkillsCommand(options: InstallOptions): Promise<void> {
  const cwd = process.cwd();
  let installed = 0;
  let skipped = 0;

  console.error(chalk.cyan('\n  Installing CodeMoot integration for Claude Code\n'));

  // ── 1. Install skill files ──
  console.error(chalk.dim('  Skills & Agents:'));
  for (const skill of SKILLS) {
    const fullPath = join(cwd, skill.path);
    const dir = dirname(fullPath);

    if (existsSync(fullPath) && !options.force) {
      console.error(chalk.dim(`  SKIP ${skill.path} (exists)`));
      skipped++;
      continue;
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, skill.content, 'utf-8');
    console.error(chalk.green(`  OK   ${skill.path}`));
    installed++;
  }

  // ── 2. Append CodeMoot section to CLAUDE.md ──
  console.error('');
  console.error(chalk.dim('  CLAUDE.md:'));
  const claudeMdPath = join(cwd, 'CLAUDE.md');
  const marker = '## CodeMoot — Multi-Model Collaboration';

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, 'utf-8');
    if (existing.includes(marker)) {
      if (options.force) {
        // Replace existing section, preserving content after it
        const markerIdx = existing.indexOf(marker);
        const before = existing.slice(0, markerIdx);
        // Find the next heading after our section ends, or end of file
        // Our section uses ### subheadings, so we detect the end by finding
        // the CLAUDE_MD_SECTION's last line, then take everything after it
        const sectionEnd = existing.indexOf(CLAUDE_MD_SECTION.trimEnd(), markerIdx);
        const afterMarker = sectionEnd >= 0
          ? existing.slice(sectionEnd + CLAUDE_MD_SECTION.trimEnd().length)
          : existing.slice(markerIdx + marker.length);
        // Fallback: find next heading at any level that isn't part of our section
        const nextHeadingMatch = sectionEnd >= 0 ? null : afterMarker.match(/\n#{1,6} (?!CodeMoot)/);
        const after = nextHeadingMatch ? afterMarker.slice(nextHeadingMatch.index as number) : '';
        writeFileSync(claudeMdPath, before.trimEnd() + '\n' + CLAUDE_MD_SECTION + after, 'utf-8');
        console.error(chalk.green('  OK   CLAUDE.md (updated CodeMoot section)'));
        installed++;
      } else {
        console.error(chalk.dim('  SKIP CLAUDE.md (CodeMoot section exists)'));
        skipped++;
      }
    } else {
      // Append section
      writeFileSync(claudeMdPath, existing.trimEnd() + '\n' + CLAUDE_MD_SECTION, 'utf-8');
      console.error(chalk.green('  OK   CLAUDE.md (appended CodeMoot section)'));
      installed++;
    }
  } else {
    writeFileSync(claudeMdPath, `# Project Instructions\n${CLAUDE_MD_SECTION}`, 'utf-8');
    console.error(chalk.green('  OK   CLAUDE.md (created with CodeMoot section)'));
    installed++;
  }

  // ── 3. Install hooks config ──
  console.error('');
  console.error(chalk.dim('  Hooks:'));
  const settingsDir = join(cwd, '.claude');
  const settingsPath = join(settingsDir, 'settings.json');

  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const hasCodemootHook = Array.isArray(existing.hooks?.PostToolUse) &&
        existing.hooks.PostToolUse.some((h: { command?: string }) => h.command?.includes('codemoot'));
      if (hasCodemootHook && !options.force) {
        console.error(chalk.dim('  SKIP .claude/settings.json (codemoot hook exists)'));
        skipped++;
      } else {
        // Merge: keep existing hooks, add/replace codemoot hook
        const otherHooks = Array.isArray(existing.hooks?.PostToolUse)
          ? existing.hooks.PostToolUse.filter((h: { command?: string }) => !h.command?.includes('codemoot'))
          : [];
        existing.hooks = {
          ...existing.hooks,
          PostToolUse: [...otherHooks, ...HOOKS_CONFIG.hooks.PostToolUse],
        };
        writeFileSync(settingsPath, JSON.stringify(existing, null, 2), 'utf-8');
        console.error(chalk.green('  OK   .claude/settings.json (added post-commit hint hook)'));
        installed++;
      }
    } catch (err) {
      console.error(chalk.yellow(`  WARN .claude/settings.json parse error: ${(err as Error).message}`));
      console.error(chalk.yellow('       Back up and delete the file, then re-run install-skills'));
      skipped++;
    }
  } else {
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(HOOKS_CONFIG, null, 2), 'utf-8');
    console.error(chalk.green('  OK   .claude/settings.json (created with post-commit hook)'));
    installed++;
  }

  // ── Summary ──
  console.error('');
  console.error(chalk.cyan(`  Installed: ${installed}, Skipped: ${skipped}`));
  console.error('');
  console.error(chalk.dim('  Slash commands: /codex-review, /debate, /plan-review, /build, /cleanup'));
  console.error(chalk.dim('  CLAUDE.md: Claude now knows about codemoot commands & sessions'));
  console.error(chalk.dim('  Hook: Post-commit hint to run codemoot review'));
  console.error('');

  const output = {
    installed,
    skipped,
    total: SKILLS.length + 2, // +CLAUDE.md +hooks
    skills: SKILLS.map(s => ({ path: s.path, description: s.description })),
  };
  console.log(JSON.stringify(output, null, 2));
}
