// packages/cli/src/commands/build.ts — CLI build commands

import type { BuildRun, BuildSummary } from '@codemoot/core';
import { BuildStore, DebateStore, REVIEW_DIFF_MAX_CHARS, REVIEW_TEXT_MAX_CHARS, SessionManager, buildHandoffEnvelope, generateId, loadConfig, openDatabase } from '@codemoot/core';
import chalk from 'chalk';
import { execFileSync, execSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { createProgressCallbacks } from '../progress.js';
import { getDbPath } from '../utils.js';

// ── codemoot build start ──

interface StartOptions {
  maxRounds?: number;
  allowDirty?: boolean;
}

export async function buildStartCommand(task: string, options: StartOptions): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const buildId = generateId();
    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const buildStore = new BuildStore(db);
    const debateStore = new DebateStore(db);
    const projectDir = process.cwd();

    // Check git status
    let baselineRef: string | null = null;
    try {
      const dirty = execSync('git status --porcelain', { cwd: projectDir, encoding: 'utf-8' }).trim();
      if (dirty && !options.allowDirty) {
        db.close();
        console.error(chalk.red('Working tree is dirty. Commit or stash your changes first.'));
        console.error(chalk.yellow('Use --allow-dirty to auto-stash.'));
        process.exit(1);
      }
      if (dirty && options.allowDirty) {
        execSync('git stash push -u -m "codemoot-build-baseline"', { cwd: projectDir, encoding: 'utf-8' });
        console.error(chalk.yellow('Auto-stashed dirty changes with marker "codemoot-build-baseline"'));
      }
      baselineRef = execSync('git rev-parse HEAD', { cwd: projectDir, encoding: 'utf-8' }).trim();
    } catch {
      // Not a git repo — no baseline
      console.error(chalk.yellow('Warning: Not a git repository. No baseline tracking.'));
    }

    // Create debate for planning phase
    const debateId = generateId();
    debateStore.upsert({ debateId, role: 'proposer', status: 'active' });
    debateStore.upsert({ debateId, role: 'critic', status: 'active' });
    debateStore.saveState(debateId, 'proposer', {
      debateId,
      question: task,
      models: ['codex-architect', 'codex-reviewer'],
      round: 0,
      turn: 0,
      thread: [],
      runningSummary: '',
      stanceHistory: [],
      usage: { totalPromptTokens: 0, totalCompletionTokens: 0, totalCalls: 0, startedAt: Date.now() },
      status: 'running',
      sessionIds: {},
      resumeStats: { attempted: 0, succeeded: 0, fallbacks: 0 },
    });

    // Resolve unified session for the build
    const sessionMgr = new SessionManager(db);
    const session = sessionMgr.resolveActive('build');
    sessionMgr.recordEvent({
      sessionId: session.id,
      command: 'build',
      subcommand: 'start',
      promptPreview: `Build started: ${task}`,
    });

    // Create build run
    buildStore.create({ buildId, task, debateId, baselineRef: baselineRef ?? undefined });

    // Record start event
    buildStore.updateWithEvent(
      buildId,
      { debateId },
      { eventType: 'debate_started', actor: 'system', phase: 'debate', payload: { task, debateId, baselineRef } },
    );

    const output = {
      buildId,
      debateId,
      task,
      baselineRef,
      sessionId: session.id,
      maxRounds: options.maxRounds ?? 5,
      status: 'planning',
      phase: 'debate',
    };
    console.log(JSON.stringify(output, null, 2));

    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot build status ──

export async function buildStatusCommand(buildId: string): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const store = new BuildStore(db);

    const run = store.get(buildId);
    if (!run) {
      db.close();
      console.error(chalk.red(`No build found with ID: ${buildId}`));
      process.exit(1);
    }

    const events = store.getEvents(buildId);
    const bugsFound = store.countEventsByType(buildId, 'bug_found');
    const fixesApplied = store.countEventsByType(buildId, 'fix_completed');

    const output = {
      buildId: run.buildId,
      task: run.task,
      status: run.status,
      phase: run.currentPhase,
      loop: run.currentLoop,
      debateId: run.debateId,
      baselineRef: run.baselineRef,
      planCodexSession: run.planCodexSession,
      reviewCodexSession: run.reviewCodexSession,
      planVersion: run.planVersion,
      reviewCycles: run.reviewCycles,
      bugsFound,
      bugsFixed: fixesApplied,
      totalEvents: events.length,
      createdAt: new Date(run.createdAt).toISOString(),
      updatedAt: new Date(run.updatedAt).toISOString(),
      completedAt: run.completedAt ? new Date(run.completedAt).toISOString() : null,
      recentEvents: events.slice(-10).map((e) => ({
        seq: e.seq,
        type: e.eventType,
        actor: e.actor,
        phase: e.phase,
        loop: e.loopIndex,
        tokens: e.tokensUsed,
        time: new Date(e.createdAt).toISOString(),
      })),
    };
    console.log(JSON.stringify(output, null, 2));

    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot build list ──

interface ListOptions {
  status?: string;
  limit?: number;
}

export async function buildListCommand(options: ListOptions): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const store = new BuildStore(db);

    const builds = store.list({
      status: options.status as BuildRun['status'] | undefined,
      limit: options.limit ?? 20,
    });

    const output = builds.map((b: BuildSummary) => ({
      buildId: b.buildId,
      task: b.task,
      status: b.status,
      phase: b.phase,
      loop: b.loop,
      reviewCycles: b.reviewCycles,
      createdAt: new Date(b.createdAt).toISOString(),
      updatedAt: new Date(b.updatedAt).toISOString(),
    }));

    console.log(JSON.stringify(output, null, 2));

    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot build event ──

interface EventOptions {
  loop?: number;
  tokens?: number;
}

export async function buildEventCommand(
  buildId: string,
  eventType: string,
  options: EventOptions,
): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const store = new BuildStore(db);

    const run = store.get(buildId);
    if (!run) {
      db.close();
      console.error(chalk.red(`No build found with ID: ${buildId}`));
      process.exit(1);
    }

    // Read payload from stdin if available
    let payload: Record<string, unknown> | undefined;
    if (!process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      const input = Buffer.concat(chunks).toString('utf-8').trim();
      if (input) {
        try { payload = JSON.parse(input); } catch { payload = { text: input }; }
      }
    }

    // Determine phase transitions
    const updates: Record<string, unknown> = {};
    if (eventType === 'plan_approved') {
      updates.currentPhase = 'plan_approved';
      updates.status = 'implementing';
      updates.planVersion = run.planVersion + 1;
    } else if (eventType === 'impl_completed') {
      updates.currentPhase = 'review';
      updates.status = 'reviewing';
    } else if (eventType === 'review_verdict') {
      const verdict = payload?.verdict as string;
      if (verdict === 'approved') {
        updates.currentPhase = 'done';
        updates.status = 'completed';
        updates.completedAt = Date.now();
      } else {
        updates.currentPhase = 'fix';
        updates.status = 'fixing';
        updates.reviewCycles = run.reviewCycles + 1;
      }
    } else if (eventType === 'fix_completed') {
      updates.currentPhase = 'review';
      updates.status = 'reviewing';
      updates.currentLoop = run.currentLoop + 1;
    }

    store.updateWithEvent(
      buildId,
      updates as Parameters<BuildStore['updateWithEvent']>[1],
      {
        eventType: eventType as Parameters<BuildStore['updateWithEvent']>[2]['eventType'],
        actor: 'system',
        phase: (updates.currentPhase ?? run.currentPhase) as Parameters<BuildStore['updateWithEvent']>[2]['phase'],
        loopIndex: options.loop ?? run.currentLoop,
        payload,
        tokensUsed: options.tokens ?? 0,
      },
    );

    const updated = store.get(buildId);
    console.log(JSON.stringify({
      buildId,
      eventType,
      newStatus: updated?.status,
      newPhase: updated?.currentPhase,
      seq: updated?.lastEventSeq,
    }));

    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot build review ──

export async function buildReviewCommand(buildId: string): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const buildStore = new BuildStore(db);
    const config = loadConfig();
    const projectDir = process.cwd();

    const run = buildStore.get(buildId);
    if (!run) {
      db.close();
      console.error(chalk.red(`No build found with ID: ${buildId}`));
      process.exit(1);
    }

    // Get diff against baseline
    let diff = '';
    if (run.baselineRef) {
      try {
        // Use a temporary index file to avoid mutating user's staging state
        const tmpIndex = join(projectDir, '.git', 'codemoot-review-index');
        try {
          // Copy current HEAD tree into temp index, then add all working tree changes
          execFileSync('git', ['read-tree', 'HEAD'], { cwd: projectDir, encoding: 'utf-8', env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
          execFileSync('git', ['add', '-A'], { cwd: projectDir, encoding: 'utf-8', env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
          diff = execFileSync('git', ['diff', '--cached', run.baselineRef, '--'], { cwd: projectDir, encoding: 'utf-8', maxBuffer: 1024 * 1024, env: { ...process.env, GIT_INDEX_FILE: tmpIndex } });
        } finally {
          try { unlinkSync(tmpIndex); } catch { /* already cleaned */ }
        }
      } catch (err) {
        console.error(chalk.red(`Failed to generate diff: ${err instanceof Error ? err.message : String(err)}`));
        db.close();
        process.exit(1);
      }
    }

    if (!diff.trim()) {
      db.close();
      console.error(chalk.yellow('No changes detected against baseline.'));
      process.exit(0);
    }

    // Call codex for review with codebase access
    const { ModelRegistry, CliAdapter: CliAdapterClass } = await import('@codemoot/core');
    const registry = ModelRegistry.fromConfig(config, projectDir);
    const adapter = registry.getAdapter('codex-reviewer') ?? registry.getAdapter('codex-architect');
    if (!adapter) {
      db.close();
      console.error(chalk.red('No codex adapter found in config'));
      process.exit(1);
    }

    // Resolve unified session
    const sessionMgr = new SessionManager(db);
    const session = sessionMgr.resolveActive('build-review');
    const overflowCheck = sessionMgr.preCallOverflowCheck(session.id);
    if (overflowCheck.rolled) {
      console.error(chalk.yellow(`  ${overflowCheck.message}`));
    }

    // After rollover, re-read session to get cleared thread ID
    const currentSession = sessionMgr.get(session.id);
    const existingSession = overflowCheck.rolled
      ? undefined  // Don't reuse old thread after rollover
      : (currentSession?.codexThreadId ?? run.reviewCodexSession ?? undefined);

    const prompt = buildHandoffEnvelope({
      command: 'build-review',
      task: `Review code changes for the task: "${run.task}"\n\nGIT DIFF (against baseline ${run.baselineRef}):\n${diff.slice(0, REVIEW_DIFF_MAX_CHARS)}\n\nReview for:\n1. Correctness — does the code work as intended?\n2. Bugs — any logic errors, edge cases, or crashes?\n3. Security — any vulnerabilities introduced?\n4. Code quality — naming, structure, patterns\n5. Completeness — does it fully implement the task?`,
      resumed: Boolean(existingSession),
      constraints: run.reviewCycles > 0 ? [`This is review cycle ${run.reviewCycles + 1}. Focus on whether prior issues were addressed.`] : undefined,
    });

    const progress = createProgressCallbacks('build-review');
    let result;
    try {
      result = await (adapter as InstanceType<typeof CliAdapterClass>).callWithResume(prompt, {
        sessionId: existingSession,
        timeout: 600_000,
        ...progress,
      });
    } catch (err) {
      // Clear stale thread ID so subsequent runs don't keep hitting a dead thread
      if (existingSession) {
        console.error(chalk.yellow('  Clearing stale codex thread ID after failure.'));
        sessionMgr.updateThreadId(session.id, null);
      }
      throw err;
    }

    // Detect resume failure — clear stale thread on session ID mismatch
    if (existingSession && result.sessionId !== existingSession) {
      sessionMgr.updateThreadId(session.id, null);
    }

    // Update unified session
    if (result.sessionId) {
      sessionMgr.updateThreadId(session.id, result.sessionId);
    }
    sessionMgr.addUsageFromResult(session.id, result.usage, prompt, result.text);
    sessionMgr.recordEvent({
      sessionId: session.id,
      command: 'build',
      subcommand: 'review',
      promptPreview: `Build review for ${buildId}: ${run.task}`,
      responsePreview: result.text.slice(0, 500),
      promptFull: prompt,
      responseFull: result.text,
      usageJson: JSON.stringify(result.usage),
      durationMs: result.durationMs,
      codexThreadId: result.sessionId,
    });

    // Determine if approved — search only the tail of the response to avoid echoed instructions
    const tail = result.text.slice(-500);
    const verdictMatch = tail.match(/^(?:-\s*)?VERDICT:\s*(APPROVED|NEEDS_REVISION)/m);
    const approved = verdictMatch?.[1] === 'APPROVED';

    // Save review session
    buildStore.updateWithEvent(
      buildId,
      {
        reviewCodexSession: result.sessionId ?? existingSession,
        reviewCycles: run.reviewCycles + 1,
      },
      {
        eventType: 'review_verdict',
        actor: 'codex',
        phase: 'review',
        loopIndex: run.currentLoop,
        payload: {
          verdict: approved ? 'approved' : 'needs_revision',
          response: result.text.slice(0, REVIEW_TEXT_MAX_CHARS),
          sessionId: result.sessionId,
          resumed: existingSession ? result.sessionId === existingSession : false,
        },
        codexThreadId: result.sessionId,
        tokensUsed: result.usage.totalTokens,
      },
    );
    if (approved) {
      buildStore.updateWithEvent(
        buildId,
        { currentPhase: 'done', status: 'completed', completedAt: Date.now() },
        { eventType: 'phase_transition', actor: 'system', phase: 'done', payload: { reason: 'review_approved' } },
      );
    } else {
      buildStore.updateWithEvent(
        buildId,
        { currentPhase: 'fix', status: 'fixing' },
        { eventType: 'phase_transition', actor: 'system', phase: 'fix', payload: { reason: 'review_needs_revision' } },
      );
    }

    const output = {
      buildId,
      review: result.text.slice(0, 2000),
      verdict: approved ? 'approved' : 'needs_revision',
      sessionId: result.sessionId,
      resumed: existingSession ? result.sessionId === existingSession : false,
      tokens: result.usage,
      durationMs: result.durationMs,
    };
    console.log(JSON.stringify(output, null, 2));

    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}
