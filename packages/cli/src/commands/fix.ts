// packages/cli/src/commands/fix.ts — Autofix loop: GPT reviews → CLI applies fixes → GPT re-reviews

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  noStage?: boolean;
}

interface ParsedFix {
  file: string;
  line: number;
  description: string;
  oldCode: string;
  newCode: string;
}

interface FixRound {
  round: number;
  reviewVerdict: string;
  reviewScore: number | null;
  criticalCount: number;
  warningCount: number;
  fixesProposed: number;
  fixesApplied: number;
  fixesFailed: number;
  exitReason: string;
  durationMs: number;
}

/**
 * Parse FIX blocks from GPT review output.
 * Expected format:
 *   FIX: <file>:<line> <description>
 *   ```old
 *   <old code>
 *   ```
 *   ```new
 *   <new code>
 *   ```
 *
 * Also supports simpler format:
 *   FIX: <file>:<line> <description>
 *   ```
 *   <replacement code>
 *   ```
 */
function parseFixes(text: string): ParsedFix[] {
  const fixes: ParsedFix[] = [];

  // Match FIX: lines followed by code blocks
  const fixPattern = /FIX:\s*(\S+?):(\d+)\s+(.+?)(?:\n```old\n([\s\S]*?)\n```\s*\n```new\n([\s\S]*?)\n```|(?:\n```\n([\s\S]*?)\n```))/g;

  let match: RegExpExecArray | null;
  match = fixPattern.exec(text);
  while (match !== null) {
    const file = match[1];
    const line = Number.parseInt(match[2], 10);
    const description = match[3].trim();

    if (match[4] !== undefined && match[5] !== undefined) {
      // old/new format
      fixes.push({ file, line, description, oldCode: match[4], newCode: match[5] });
    } else if (match[6] !== undefined) {
      // Simple replacement format — we'll need the old code from the file
      fixes.push({ file, line, description, oldCode: '', newCode: match[6] });
    }
    match = fixPattern.exec(text);
  }

  return fixes;
}

/**
 * Apply a single fix to a file. Returns true if applied successfully.
 */
function applyFix(fix: ParsedFix, projectDir: string): boolean {
  const filePath = resolve(projectDir, fix.file);

  // Path traversal guard: resolved path must stay within projectDir
  const normalizedProject = resolve(projectDir) + (process.platform === 'win32' ? '\\' : '/');
  if (!resolve(filePath).startsWith(normalizedProject)) {
    return false;
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }

  const lines = content.split('\n');

  if (fix.oldCode) {
    // Exact string replacement
    const trimmedOld = fix.oldCode.trim();
    if (content.includes(trimmedOld)) {
      const updated = content.replace(trimmedOld, fix.newCode.trim());
      writeFileSync(filePath, updated, 'utf-8');
      return true;
    }
    return false;
  }

  // Line-based replacement (simple format)
  const lineIdx = fix.line - 1;
  if (lineIdx < 0 || lineIdx >= lines.length) return false;

  const newLines = fix.newCode.trim().split('\n');
  // Replace the target line(s) with the new code
  const oldLineCount = Math.max(1, newLines.length);
  lines.splice(lineIdx, oldLineCount, ...newLines);
  writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return true;
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
  const stuckFingerprints = new Set<string>();
  let prevFingerprints = new Set<string>();

  console.error(
    chalk.cyan(
      `Autofix loop: ${fileOrGlob} (max ${options.maxRounds} rounds, focus: ${options.focus})`,
    ),
  );

  for (let round = 1; round <= options.maxRounds; round++) {
    const overflowCheck = sessionMgr.preCallOverflowCheck(session.id);
    if (overflowCheck.rolled) {
      console.error(chalk.yellow(`  ${overflowCheck.message}`));
      threadId = undefined;
    }

    const roundStart = Date.now();
    console.error(chalk.dim(`\n── Round ${round}/${options.maxRounds} ──`));

    // Step 1: GPT reviews and proposes fixes
    let diffContent = '';
    if (options.diff) {
      try {
        diffContent = execFileSync('git', ['diff', '--', ...options.diff.split(/\s+/)], {
          cwd: projectDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
      } catch {
        diffContent = '';
      }
    }

    const fixOutputContract = [
      'You are an autofix engine. For EVERY fixable issue, you MUST output this EXACT format:',
      '',
      'FIX: path/to/file.ts:42 Description of the bug',
      '```old',
      'exact old code copied from the file',
      '```',
      '```new',
      'exact replacement code',
      '```',
      '',
      'Then end with:',
      'VERDICT: APPROVED or VERDICT: NEEDS_REVISION',
      'SCORE: X/10',
      '',
      'Rules:',
      '- The ```old block MUST be an exact substring copy from the file (whitespace-sensitive).',
      '- One FIX block per issue.',
      '- Issues without a FIX block are IGNORED by the autofix engine.',
      '- If the code is clean, output VERDICT: APPROVED with no FIX blocks.',
    ].join('\n');

    const reviewPrompt = buildHandoffEnvelope({
      command: 'custom',
      task: options.diff
        ? `Review and identify fixable issues in this diff.\n\nGIT DIFF (${options.diff}):\n${diffContent.slice(0, REVIEW_DIFF_MAX_CHARS)}\n\n${fixOutputContract}`
        : `Review ${fileOrGlob} and identify fixable issues. Read the file(s) first, then report issues with exact line numbers and exact fixes.\n\n${fixOutputContract}`,
      constraints: [
        `Focus: ${options.focus}`,
        round > 1
          ? `This is re-review round ${round}. Previous fixes were applied by the host. Only report REMAINING unfixed issues.`
          : '',
      ].filter(Boolean),
      resumed: Boolean(threadId),
    });

    const timeoutMs = options.timeout * 1000;
    const progress = createProgressCallbacks('fix-review');

    console.error(chalk.dim('  GPT reviewing...'));
    let reviewResult;
    try {
      reviewResult = await (adapter as CliAdapter).callWithResume(reviewPrompt, {
        sessionId: threadId,
        timeout: timeoutMs,
        ...progress,
      });
    } catch (err) {
      // If the call fails entirely (stale thread, codex crash, etc.), clear the
      // stored thread ID so subsequent runs don't keep hitting the same dead thread.
      if (threadId) {
        console.error(chalk.yellow('  Clearing stale codex thread ID after failure.'));
        sessionMgr.updateThreadId(session.id, null);
        threadId = undefined;
      }
      throw err;
    }

    // Detect resume failure: callWithResume falls back to fresh exec internally,
    // returning a NEW sessionId. Clear stale thread so future rounds use the new one.
    const resumed = threadId && reviewResult.sessionId === threadId;
    if (threadId && !resumed) {
      threadId = undefined;
      sessionMgr.updateThreadId(session.id, null);
    }

    if (reviewResult.sessionId) {
      threadId = reviewResult.sessionId;
      sessionMgr.updateThreadId(session.id, reviewResult.sessionId);
    }
    sessionMgr.addUsageFromResult(session.id, reviewResult.usage, reviewPrompt, reviewResult.text);

    sessionMgr.recordEvent({
      sessionId: session.id,
      command: 'fix',
      subcommand: `review-round-${round}`,
      promptPreview: `Fix review round ${round}: ${fileOrGlob}`,
      responsePreview: reviewResult.text.slice(0, 500),
      promptFull: reviewPrompt,
      responseFull: reviewResult.text,
      usageJson: JSON.stringify(reviewResult.usage),
      durationMs: reviewResult.durationMs,
      codexThreadId: reviewResult.sessionId,
    });

    // Parse verdict
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

    // Check if approved
    if (verdict === 'approved' && criticalCount === 0) {
      rounds.push({
        round,
        reviewVerdict: verdict,
        reviewScore: score,
        criticalCount,
        warningCount,
        fixesProposed: 0,
        fixesApplied: 0,
        fixesFailed: 0,
        exitReason: 'all_resolved',
        durationMs: Date.now() - roundStart,
      });
      converged = true;
      console.error(chalk.green('  APPROVED — all issues resolved.'));
      break;
    }

    // Parse fixes from GPT output
    const fixes = parseFixes(reviewResult.text);
    console.error(chalk.dim(`  Found ${fixes.length} fix proposal(s)`));

    if (fixes.length === 0) {
      rounds.push({
        round,
        reviewVerdict: verdict,
        reviewScore: score,
        criticalCount,
        warningCount,
        fixesProposed: 0,
        fixesApplied: 0,
        fixesFailed: 0,
        exitReason: 'no_fixes_proposed',
        durationMs: Date.now() - roundStart,
      });
      console.error(chalk.yellow('  GPT found issues but proposed no structured fixes. Stopping.'));
      break;
    }

    if (options.dryRun) {
      console.error(chalk.yellow('  Dry-run: showing proposed fixes without applying.'));
      for (const fix of fixes) {
        console.error(chalk.dim(`    ${fix.file}:${fix.line} — ${fix.description}`));
      }
      rounds.push({
        round,
        reviewVerdict: verdict,
        reviewScore: score,
        criticalCount,
        warningCount,
        fixesProposed: fixes.length,
        fixesApplied: 0,
        fixesFailed: 0,
        exitReason: 'dry_run',
        durationMs: Date.now() - roundStart,
      });
      continue;
    }

    // Step 2: Apply fixes locally (host applies, not GPT)
    let applied = 0;
    let failed = 0;
    const currentFingerprints = new Set<string>();

    for (const fix of fixes) {
      const fingerprint = `${fix.file}:${fix.description}`;
      currentFingerprints.add(fingerprint);

      if (stuckFingerprints.has(fingerprint)) {
        console.error(chalk.dim(`    Skip (stuck): ${fix.file}:${fix.line}`));
        continue;
      }

      // Mark as stuck if same fingerprint appeared in previous round
      if (prevFingerprints.has(fingerprint)) {
        stuckFingerprints.add(fingerprint);
        console.error(chalk.yellow(`    Stuck (recurring): ${fix.file}:${fix.line} — ${fix.description}`));
        failed++;
        continue;
      }

      const success = applyFix(fix, projectDir);
      if (success) {
        applied++;
        console.error(chalk.green(`    Fixed: ${fix.file}:${fix.line} — ${fix.description}`));
      } else {
        failed++;
        console.error(chalk.red(`    Failed: ${fix.file}:${fix.line} — could not match old code`));
      }
    }

    prevFingerprints = currentFingerprints;

    // Stage changes unless --no-stage
    if (applied > 0 && !options.noStage) {
      try {
        execFileSync('git', ['add', '-A'], { cwd: projectDir, stdio: 'pipe' });
        console.error(chalk.dim('  Changes staged.'));
      } catch {
        console.error(chalk.yellow('  Could not stage changes (not a git repo?).'));
      }
    }

    const exitReason = applied === 0 ? 'no_diff' : 'continue';

    rounds.push({
      round,
      reviewVerdict: verdict,
      reviewScore: score,
      criticalCount,
      warningCount,
      fixesProposed: fixes.length,
      fixesApplied: applied,
      fixesFailed: failed,
      exitReason,
      durationMs: Date.now() - roundStart,
    });

    if (applied === 0) {
      console.error(chalk.yellow('  No fixes applied — stopping loop.'));
      break;
    }

    // Check if all remaining are stuck
    if (stuckFingerprints.size >= fixes.length) {
      console.error(chalk.yellow('  All remaining issues are stuck — stopping.'));
      break;
    }

    console.error(chalk.dim(`  Applied ${applied}, failed ${failed}. Continuing to re-review...`));
  }

  // Final summary
  const lastRound = rounds[rounds.length - 1];
  const totalApplied = rounds.reduce((sum, r) => sum + r.fixesApplied, 0);
  const totalProposed = rounds.reduce((sum, r) => sum + r.fixesProposed, 0);

  const policyCtx: PolicyContext = {
    criticalCount: lastRound?.criticalCount ?? 0,
    warningCount: lastRound?.warningCount ?? 0,
    verdict: lastRound?.reviewVerdict ?? 'unknown',
    stepsCompleted: { fix: converged ? 'passed' : 'failed' },
    cleanupHighCount: 0,
  };
  const policy = evaluatePolicy('review.completed', policyCtx, DEFAULT_RULES);

  const exitReason = converged
    ? 'all_resolved'
    : stuckFingerprints.size > 0
      ? 'all_stuck'
      : lastRound?.exitReason ?? 'max_iterations';

  const output = {
    target: fileOrGlob,
    converged,
    exitReason,
    rounds,
    totalRounds: rounds.length,
    totalFixesProposed: totalProposed,
    totalFixesApplied: totalApplied,
    stuckCount: stuckFingerprints.size,
    finalVerdict: lastRound?.reviewVerdict ?? 'unknown',
    finalScore: lastRound?.reviewScore ?? null,
    policy,
    sessionId: session.id,
    codexThreadId: threadId,
  };

  // Human-readable summary
  const color = converged ? chalk.green : chalk.red;
  console.error(color(`\nResult: ${converged ? 'CONVERGED' : 'NOT CONVERGED'} (${exitReason})`));
  console.error(`  Rounds: ${rounds.length}/${options.maxRounds}`);
  console.error(`  Fixes: ${totalApplied} applied, ${totalProposed - totalApplied} failed/skipped`);
  if (stuckFingerprints.size > 0) {
    console.error(chalk.yellow(`  Stuck issues: ${stuckFingerprints.size}`));
  }
  console.error(`  Final: ${lastRound?.reviewVerdict ?? '?'} (${lastRound?.reviewScore ?? '?'}/10)`);

  console.log(JSON.stringify(output, null, 2));
  db.close();
}
