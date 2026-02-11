// packages/cli/src/commands/fix.ts — Autofix loop: review → propose fix → apply → re-review

import { execFileSync, execSync } from 'node:child_process';
import {
  type CliAdapter,
  DEFAULT_RULES,
  ModelRegistry,
  type PolicyContext,
  SessionManager,
  buildHandoffEnvelope,
  evaluatePolicy,
  loadConfig,
  openDatabase,
  REVIEW_DIFF_MAX_CHARS,
} from '@codemoot/core';
import chalk from 'chalk';

import { createProgressCallbacks } from '../progress.js';
import { getDbPath } from '../utils.js';

interface FixOptions {
  maxRounds: number;
  focus: string;
  timeout: number;
  dryRun: boolean;
  diff?: string;
  session?: string;
}

interface FixRound {
  round: number;
  reviewVerdict: string;
  reviewScore: number | null;
  criticalCount: number;
  warningCount: number;
  fixApplied: boolean;
  durationMs: number;
}

export async function fixCommand(fileOrGlob: string, options: FixOptions): Promise<void> {
  const projectDir = process.cwd();
  const db = openDatabase(getDbPath());
  const config = loadConfig();
  const registry = ModelRegistry.fromConfig(config, projectDir);
  const adapter =
    registry.tryGetAdapter('codex-reviewer') ?? registry.tryGetAdapter('codex-architect');

  if (!adapter) {
    try {
      execSync('codex --version', { stdio: 'pipe', encoding: 'utf-8' });
    } catch {
      console.error(chalk.red('Codex CLI is not installed or not in PATH.'));
      console.error(chalk.yellow('Install it: npm install -g @openai/codex'));
      db.close();
      process.exit(1);
    }
    console.error(chalk.red('No codex adapter found in config. Run: codemoot init'));
    db.close();
    process.exit(1);
  }

  const sessionMgr = new SessionManager(db);
  const session = options.session
    ? sessionMgr.get(options.session)
    : sessionMgr.resolveActive('fix');

  if (!session) {
    console.error(chalk.red(options.session
      ? `Session not found: ${options.session}`
      : 'No active session. Run: codemoot init'));
    db.close();
    process.exit(1);
  }

  const currentSession = sessionMgr.get(session.id);
  let threadId = currentSession?.codexThreadId ?? undefined;
  const rounds: FixRound[] = [];
  let converged = false;

  console.error(
    chalk.cyan(
      `Autofix loop: ${fileOrGlob} (max ${options.maxRounds} rounds, focus: ${options.focus})`,
    ),
  );

  for (let round = 1; round <= options.maxRounds; round++) {
    // Auto-rollover on session overflow (checked each round)
    const overflowCheck = sessionMgr.preCallOverflowCheck(session.id);
    if (overflowCheck.rolled) {
      console.error(chalk.yellow(`  ${overflowCheck.message}`));
      threadId = undefined; // Don't reuse old thread after rollover
    }

    const roundStart = Date.now();
    console.error(chalk.dim(`\n── Round ${round}/${options.maxRounds} ──`));

    // Step 1: Review
    let diffContent = '';
    if (options.diff) {
      try {
        diffContent = execFileSync('git', ['diff', ...options.diff.split(/\s+/)], {
          cwd: projectDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
      } catch {
        diffContent = '';
      }
    }

    const reviewPrompt = buildHandoffEnvelope({
      command: 'review',
      task: options.diff
        ? `Review and identify fixable issues in this diff.\n\nGIT DIFF (${options.diff}):\n${diffContent.slice(0, REVIEW_DIFF_MAX_CHARS)}`
        : `Review ${fileOrGlob} and identify fixable issues. Read the file(s) first, then report issues with exact line numbers.`,
      constraints: [
        `Focus: ${options.focus}`,
        'For each issue, provide the EXACT fix as a code snippet.',
        'Format fixes as: FIX: <file>:<line> <description>\n```\n<fixed code>\n```',
        round > 1
          ? `This is re-review round ${round}. Previous fixes were applied. Check if issues are resolved.`
          : '',
      ].filter(Boolean),
      resumed: Boolean(threadId),
    });

    const timeoutMs = options.timeout * 1000;
    const progress = createProgressCallbacks('fix-review');

    console.error(chalk.dim('  Reviewing...'));
    const reviewResult = await (adapter as CliAdapter).callWithResume(reviewPrompt, {
      sessionId: threadId,
      timeout: timeoutMs,
      ...progress,
    });

    if (reviewResult.sessionId) {
      threadId = reviewResult.sessionId;
      sessionMgr.updateThreadId(session.id, reviewResult.sessionId);
    }
    sessionMgr.addUsageFromResult(session.id, reviewResult.usage, reviewPrompt, reviewResult.text);

    // Parse review findings
    const tail = reviewResult.text.slice(-500);
    const verdictMatch = tail.match(/VERDICT:\s*(APPROVED|NEEDS_REVISION)/i);
    const scoreMatch = tail.match(/SCORE:\s*(\d+)\/10/);
    const verdict = verdictMatch ? verdictMatch[1].toLowerCase() : 'unknown';
    const score = scoreMatch ? Number.parseInt(scoreMatch[1], 10) : null;

    const criticalCount = (reviewResult.text.match(/CRITICAL/gi) ?? []).length;
    const warningCount = (reviewResult.text.match(/WARNING/gi) ?? []).length;

    console.error(
      `  Verdict: ${verdict}, Score: ${score ?? '?'}/10, Critical: ${criticalCount}, Warning: ${warningCount}`,
    );

    // Check if approved — converged
    if (verdict === 'approved' && criticalCount === 0) {
      rounds.push({
        round,
        reviewVerdict: verdict,
        reviewScore: score,
        criticalCount,
        warningCount,
        fixApplied: false,
        durationMs: Date.now() - roundStart,
      });
      converged = true;
      console.error(chalk.green('  Review APPROVED — no fixes needed.'));
      break;
    }

    // Step 2: Ask codex to apply fixes
    if (options.dryRun) {
      console.error(chalk.yellow('  Dry-run: skipping fix application.'));
      rounds.push({
        round,
        reviewVerdict: verdict,
        reviewScore: score,
        criticalCount,
        warningCount,
        fixApplied: false,
        durationMs: Date.now() - roundStart,
      });
      continue;
    }

    console.error(chalk.dim('  Applying fixes...'));

    const fixPrompt = buildHandoffEnvelope({
      command: 'custom',
      task: `Based on the review above, apply ALL suggested fixes to the codebase. Use your file editing tools to make the changes. After applying, verify the changes compile correctly. Only fix issues that were identified — do not refactor or change unrelated code.`,
      constraints: [
        'Make minimal, targeted changes only.',
        'Do not add comments, docstrings, or formatting changes.',
        'If a fix is ambiguous, skip it rather than guess.',
      ],
      resumed: true,
    });

    const fixResult = await (adapter as CliAdapter).callWithResume(fixPrompt, {
      sessionId: threadId,
      timeout: timeoutMs,
      ...progress,
    });

    if (fixResult.sessionId) {
      threadId = fixResult.sessionId;
      sessionMgr.updateThreadId(session.id, fixResult.sessionId);
    }
    sessionMgr.addUsageFromResult(session.id, fixResult.usage, fixPrompt, fixResult.text);

    const fixApplied =
      !fixResult.text.includes('no changes') && !fixResult.text.includes('No fixes');
    console.error(
      fixApplied ? chalk.green('  Fixes applied.') : chalk.yellow('  No fixes applied.'),
    );

    rounds.push({
      round,
      reviewVerdict: verdict,
      reviewScore: score,
      criticalCount,
      warningCount,
      fixApplied,
      durationMs: Date.now() - roundStart,
    });

    if (!fixApplied) {
      console.error(chalk.yellow('  No changes made — stopping loop.'));
      break;
    }
  }

  // Policy check
  const lastRound = rounds[rounds.length - 1];
  const policyCtx: PolicyContext = {
    criticalCount: lastRound?.criticalCount ?? 0,
    warningCount: lastRound?.warningCount ?? 0,
    verdict: lastRound?.reviewVerdict ?? 'unknown',
    stepsCompleted: { fix: converged ? 'passed' : 'failed' },
    cleanupHighCount: 0,
  };
  const policy = evaluatePolicy('review.completed', policyCtx, DEFAULT_RULES);

  const output = {
    target: fileOrGlob,
    converged,
    rounds,
    totalRounds: rounds.length,
    finalVerdict: lastRound?.reviewVerdict ?? 'unknown',
    finalScore: lastRound?.reviewScore ?? null,
    policy,
    sessionId: session.id,
    codexThreadId: threadId,
  };

  console.log(JSON.stringify(output, null, 2));
  db.close();
}
