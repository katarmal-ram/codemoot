// packages/cli/src/commands/plan.ts — Plan generation and review commands

import { readFileSync, writeFileSync } from 'node:fs';

import {
  type CliAdapter,
  ModelRegistry,
  Orchestrator,
  SessionManager,
  buildHandoffEnvelope,
  loadConfig,
  openDatabase,
} from '@codemoot/core';
import chalk from 'chalk';

import { createProgressCallbacks } from '../progress.js';
import { printSessionSummary, renderEvent } from '../render.js';
import { getDbPath } from '../utils.js';

// ── codemoot plan generate <task> (legacy behavior) ──

interface GenerateOptions {
  rounds?: number;
  output?: string;
}

export async function planGenerateCommand(task: string, options: GenerateOptions): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const config = loadConfig();
    const projectDir = process.cwd();
    const registry = ModelRegistry.fromConfig(config, projectDir);

    const dbPath = getDbPath();
    db = openDatabase(dbPath);

    const orchestrator = new Orchestrator({ registry, db, config });
    orchestrator.on('event', (event) => renderEvent(event, config));

    const result = await orchestrator.plan(task, {
      maxRounds: options.rounds,
    });

    if (options.output) {
      writeFileSync(options.output, result.finalOutput, 'utf-8');
      console.error(chalk.green(`Plan saved to ${options.output}`));
    }

    printSessionSummary(result);

    db.close();
    process.exit(result.status === 'completed' ? 0 : 2);
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot plan review <plan-file> ──

interface ReviewOptions {
  build?: string;
  phase?: string;
  timeout?: number;
  output?: string;
}

export async function planReviewCommand(planFile: string, options: ReviewOptions): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    // Read plan content
    let planContent: string;
    if (planFile === '-') {
      // Read from stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      planContent = Buffer.concat(chunks).toString('utf-8');
    } else {
      planContent = readFileSync(planFile, 'utf-8');
    }

    if (!planContent.trim()) {
      console.error(chalk.red('Plan file is empty.'));
      process.exit(1);
    }

    const config = loadConfig();
    const projectDir = process.cwd();
    const registry = ModelRegistry.fromConfig(config, projectDir);
    const adapter =
      registry.tryGetAdapter('codex-reviewer') ?? registry.tryGetAdapter('codex-architect');

    if (!adapter) {
      console.error(chalk.red('No codex adapter found in config. Run: codemoot init'));
      process.exit(1);
    }

    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const sessionMgr = new SessionManager(db);
    const session = sessionMgr.resolveActive('plan-review');

    const currentSession = sessionMgr.get(session.id);
    const threadId = currentSession?.codexThreadId ?? undefined;

    // Build review prompt — send the plan to codex for structured review
    const phaseContext = options.phase ? `\nThis is Phase ${options.phase} of a multi-phase plan.` : '';
    const buildContext = options.build ? `\nBuild ID: ${options.build}` : '';

    const prompt = buildHandoffEnvelope({
      command: 'plan-review',
      task: `Review the following execution plan for completeness, correctness, and feasibility. Read relevant codebase files to verify the plan's assumptions.${phaseContext}${buildContext}

PLAN:
${planContent.slice(0, 50_000)}

Review criteria:
1. Are all files/functions mentioned actually present in the codebase?
2. Are there missing steps or dependencies between phases?
3. Are there architectural concerns or better approaches?
4. Is the scope realistic for the described phases?
5. Are there security or performance concerns?

Output format:
- For each issue, output: ISSUE: [HIGH|MEDIUM|LOW] <description>
- For each suggestion, output: SUGGEST: <description>
- End with: VERDICT: APPROVED or VERDICT: NEEDS_REVISION
- End with: SCORE: X/10`,
      constraints: [
        'Verify file paths and function names against the actual codebase before flagging issues.',
        'Be specific — reference exact files and line numbers when possible.',
        'Focus on feasibility, not style preferences.',
      ],
      resumed: Boolean(threadId),
    });

    const timeoutMs = (options.timeout ?? 300) * 1000;
    const progress = createProgressCallbacks('plan-review');

    console.error(chalk.cyan('Sending plan to codex for review...'));
    let result;
    try {
      result = await (adapter as CliAdapter).callWithResume(prompt, {
        sessionId: threadId,
        timeout: timeoutMs,
        ...progress,
      });
    } catch (err) {
      // Clear stale thread ID so subsequent runs don't keep hitting a dead thread
      if (threadId) {
        console.error(chalk.yellow('  Clearing stale codex thread ID after failure.'));
        sessionMgr.updateThreadId(session.id, null);
      }
      throw err;
    }

    // Detect resume failure — clear stale thread on session ID mismatch
    if (threadId && result.sessionId !== threadId) {
      sessionMgr.updateThreadId(session.id, null);
    }

    // Update session
    if (result.sessionId) {
      sessionMgr.updateThreadId(session.id, result.sessionId);
    }
    sessionMgr.addUsageFromResult(session.id, result.usage, prompt, result.text);
    sessionMgr.recordEvent({
      sessionId: session.id,
      command: 'plan',
      subcommand: 'review',
      promptPreview: `Plan review: ${planFile}${options.phase ? ` (phase ${options.phase})` : ''}`,
      responsePreview: result.text.slice(0, 500),
      promptFull: prompt,
      responseFull: result.text,
      usageJson: JSON.stringify(result.usage),
      durationMs: result.durationMs,
      codexThreadId: result.sessionId,
    });

    // Parse verdict
    const tail = result.text.slice(-500);
    const verdictMatch = tail.match(/VERDICT:\s*(APPROVED|NEEDS_REVISION)/i);
    const scoreMatch = tail.match(/SCORE:\s*(\d+)\/10/);
    const verdict = verdictMatch ? verdictMatch[1].toLowerCase() : 'unknown';
    const score = scoreMatch ? Number.parseInt(scoreMatch[1], 10) : null;

    // Parse issues and suggestions
    const issues: Array<{ severity: string; message: string }> = [];
    const suggestions: string[] = [];
    for (const line of result.text.split('\n')) {
      const issueMatch = line.match(/^[-*]?\s*ISSUE:\s*\[(HIGH|MEDIUM|LOW)]\s*(.*)/i);
      if (issueMatch) {
        issues.push({ severity: issueMatch[1].toLowerCase(), message: issueMatch[2].trim() });
      }
      const suggestMatch = line.match(/^[-*]?\s*SUGGEST:\s*(.*)/i);
      if (suggestMatch) {
        suggestions.push(suggestMatch[1].trim());
      }
    }

    // Human-readable output on stderr
    const verdictColor = verdict === 'approved' ? chalk.green : chalk.red;
    console.error(verdictColor(`\nVerdict: ${verdict.toUpperCase()} (${score ?? '?'}/10)`));
    if (issues.length > 0) {
      console.error(chalk.yellow(`Issues (${issues.length}):`));
      for (const issue of issues) {
        const sevColor = issue.severity === 'high' ? chalk.red : issue.severity === 'medium' ? chalk.yellow : chalk.dim;
        console.error(`  ${sevColor(issue.severity.toUpperCase())} ${issue.message}`);
      }
    }
    if (suggestions.length > 0) {
      console.error(chalk.cyan(`Suggestions (${suggestions.length}):`));
      for (const s of suggestions) {
        console.error(`  ${chalk.dim('→')} ${s}`);
      }
    }
    console.error(chalk.dim(`Duration: ${(result.durationMs / 1000).toFixed(1)}s | Tokens: ${result.usage.totalTokens}`));

    // JSON output on stdout (capped)
    const output = {
      planFile,
      phase: options.phase ?? null,
      buildId: options.build ?? null,
      verdict,
      score,
      issues,
      suggestions,
      review: result.text.slice(0, 2000),
      sessionId: result.sessionId,
      resumed: threadId ? result.sessionId === threadId : false,
      usage: result.usage,
      durationMs: result.durationMs,
    };
    console.log(JSON.stringify(output, null, 2));

    // Save to file if requested
    if (options.output) {
      writeFileSync(options.output, JSON.stringify(output, null, 2), 'utf-8');
      console.error(chalk.green(`Review saved to ${options.output}`));
    }

    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}
