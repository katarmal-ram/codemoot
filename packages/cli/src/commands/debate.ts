// packages/cli/src/commands/debate.ts — CLI debate commands wired to core backend

import type { DebateEngineState, DebateTurnRow } from '@codemoot/core';
import {
  CliAdapter,
  DebateStore,
  MessageStore,
  ModelRegistry,
  SessionManager,
  buildReconstructionPrompt,
  generateId,
  getTokenBudgetStatus,
  loadConfig,
  openDatabase,
  parseDebateVerdict,
  preflightTokenCheck,
} from '@codemoot/core';
import chalk from 'chalk';

import { createProgressCallbacks } from '../progress.js';
import { getDbPath } from '../utils.js';

// ── codemoot debate start ──

interface StartOptions {
  maxRounds?: number;
}

export async function debateStartCommand(topic: string, options: StartOptions): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const debateId = generateId();
    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const store = new DebateStore(db);

    // Create rows for both participants
    store.upsert({ debateId, role: 'proposer', status: 'active' });
    store.upsert({ debateId, role: 'critic', status: 'active' });

    // Persist the topic as state_json on the proposer row
    store.saveState(debateId, 'proposer', {
      debateId,
      question: topic,
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
      maxRounds: options.maxRounds ?? 5,
    } as DebateEngineState & { maxRounds: number });

    // Output JSON for the /debate skill to parse
    const output = {
      debateId,
      topic,
      maxRounds: options.maxRounds ?? 5,
      status: 'started',
    };
    console.log(JSON.stringify(output, null, 2));

    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot debate turn ──

interface TurnOptions {
  round?: number;
  timeout?: number;
}

export async function debateTurnCommand(
  debateId: string,
  prompt: string,
  options: TurnOptions,
): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const store = new DebateStore(db);
    const msgStore = new MessageStore(db);
    const config = loadConfig();
    const projectDir = process.cwd();
    const registry = ModelRegistry.fromConfig(config, projectDir);

    // Get existing critic row for session resume
    const criticRow = store.get(debateId, 'critic');
    if (!criticRow) {
      db.close();
      console.error(chalk.red(`No debate found with ID: ${debateId}`));
      process.exit(1);
    }
    if (criticRow.status === 'completed') {
      db.close();
      console.error(chalk.red(`Debate ${debateId} is already completed. Start a new debate to continue discussion.`));
      process.exit(1);
    }

    // Get the codex adapter (try reviewer first, fallback to architect)
    const adapter = registry.tryGetAdapter('codex-reviewer') ?? registry.tryGetAdapter('codex-architect');
    if (!adapter) {
      db.close();
      console.error(chalk.red('No codex adapter found in config. Available: codex-reviewer or codex-architect'));
      process.exit(1);
    }

    const rawRound = options.round ?? (criticRow.round + 1);
    const newRound = Number.isFinite(rawRound) && rawRound > 0 ? rawRound : criticRow.round + 1;
    const rawTimeout = options.timeout ?? 600;
    const timeout = (Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 600) * 1000;

    // Enforce maxRounds from persisted state
    const proposerStateForLimit = store.loadState(debateId, 'proposer');
    const rawMax = (proposerStateForLimit as (typeof proposerStateForLimit & { maxRounds?: number }))?.maxRounds ?? 5;
    const maxRounds = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 5;
    if (newRound > maxRounds) {
      console.error(chalk.red(`Round ${newRound} exceeds max rounds (${maxRounds}). Complete or increase limit.`));
      db.close();
      process.exit(1);
    }

    // Idempotency: check for existing message at this (debate, round, role)
    const existing = msgStore.getByRound(debateId, newRound, 'critic');
    if (existing?.status === 'completed') {
      // Reconcile debate_turns round in case of prior crash between markCompleted and upsert
      if (criticRow.round < newRound) {
        store.upsert({
          debateId,
          role: 'critic',
          codexSessionId: existing.sessionId ?? criticRow.codexSessionId ?? undefined,
          round: newRound,
          status: 'active',
        });
      }
      // Return cached response
      const output = {
        debateId,
        round: newRound,
        response: existing.responseText?.slice(0, 2000) ?? '',
        sessionId: existing.sessionId,
        resumed: false,
        cached: true,
        usage: existing.usageJson ? (() => { try { return JSON.parse(existing.usageJson); } catch { return null; } })() : null,
        durationMs: existing.durationMs,
      };
      console.log(JSON.stringify(output, null, 2));
      db.close();
      return;
    }

    // Recover stale running rows for THIS debate only (use timeout + buffer to avoid killing active turns)
    const staleThreshold = timeout + 60_000; // turn timeout + 1 min buffer
    const recovered = msgStore.recoverStaleForDebate(debateId, staleThreshold);
    if (recovered > 0) {
      console.error(chalk.yellow(`  Recovered ${recovered} stale message(s) from prior crash.`));
    }

    // Re-fetch after recovery (status may have changed from running → failed)
    const current = msgStore.getByRound(debateId, newRound, 'critic');

    // Insert or reuse message row (update prompt if retrying with different text)
    let msgId: number;
    if (current) {
      msgId = current.id;
      if (current.status === 'failed' || current.status === 'queued') {
        msgStore.updatePrompt(msgId, prompt);
      }
    } else {
      msgId = msgStore.insertQueued({
        debateId,
        round: newRound,
        role: 'critic',
        bridge: 'codex',
        model: (adapter as CliAdapter).modelId ?? 'codex',
        promptText: prompt,
      });
    }

    // Transition to running (if another process completed it in between, return cached)
    if (!msgStore.markRunning(msgId)) {
      const recheckRow = msgStore.getByRound(debateId, newRound, 'critic');
      if (recheckRow?.status === 'completed') {
        const output = {
          debateId,
          round: newRound,
          response: recheckRow.responseText?.slice(0, 2000) ?? '',
          sessionId: recheckRow.sessionId,
          resumed: false,
          cached: true,
          usage: recheckRow.usageJson ? (() => { try { return JSON.parse(recheckRow.usageJson); } catch { return null; } })() : null,
          durationMs: recheckRow.durationMs,
        };
        console.log(JSON.stringify(output, null, 2));
        db.close();
        return;
      }
      db.close();
      console.error(chalk.red(`Cannot transition message ${msgId} to running (current status: ${recheckRow?.status})`));
      process.exit(1);
    }

    // Resolve unified session (source of truth for thread_id)
    const sessionMgr = new SessionManager(db);
    const unifiedSession = sessionMgr.resolveActive('debate');
    let existingSessionId = unifiedSession.codexThreadId ?? criticRow.codexSessionId ?? undefined;
    const attemptedResume = existingSessionId != null;

    // Token budget preflight check (only completed rows = real conversation context)
    const completedHistory = msgStore.getHistory(debateId).filter(m => m.status === 'completed');
    const maxContext = (adapter as CliAdapter).capabilities.maxContextTokens;
    const preflight = preflightTokenCheck(completedHistory, prompt, maxContext);
    if (preflight.shouldStop) {
      console.error(chalk.yellow(`  Token budget at ${Math.round(preflight.utilizationRatio * 100)}% (${preflight.totalTokensUsed}/${maxContext}). Consider completing this debate.`));
    } else if (preflight.shouldSummarize) {
      console.error(chalk.yellow(`  Token budget at ${Math.round(preflight.utilizationRatio * 100)}%. Older rounds will be summarized on resume failure.`));
    }

    // Auto-rollover on session overflow
    const overflowCheck = sessionMgr.preCallOverflowCheck(unifiedSession.id);
    if (overflowCheck.rolled) {
      console.error(chalk.yellow(`  ${overflowCheck.message}`));
      existingSessionId = undefined; // Don't reuse old thread after rollover
    }

    try {
      // Call GPT via codex with session resume + progress feedback
      const progress = createProgressCallbacks('debate');
      let result = await (adapter as CliAdapter).callWithResume(prompt, {
        sessionId: existingSessionId,
        timeout,
        ...progress,
      });

      // Detect resume outcome
      const resumed = attemptedResume && result.sessionId === existingSessionId;
      const resumeFailed = attemptedResume && !resumed;

      // If resume failed, reconstruct context from stored history and retry
      if (resumeFailed && result.text.length < 50) {
        console.error(chalk.yellow('  Resume failed with minimal response. Reconstructing from ledger...'));
        const history = msgStore.getHistory(debateId);
        const reconstructed = buildReconstructionPrompt(history, prompt);
        result = await (adapter as CliAdapter).callWithResume(reconstructed, {
          timeout,
          ...progress,
        });
      }

      // Warn about possible codex output truncation
      if (result.text.length < 200 && (result.durationMs ?? 0) > 60_000) {
        console.error(chalk.yellow(`  Warning: GPT response is only ${result.text.length} chars after ${Math.round((result.durationMs ?? 0) / 1000)}s — possible output truncation (codex may have spent its turn on tool calls).`));
      }

      // Parse verdict from response
      const verdict = parseDebateVerdict(result.text);

      // Mark completed in message ledger
      const completed = msgStore.markCompleted(msgId, {
        responseText: result.text,
        verdict,
        usageJson: JSON.stringify(result.usage),
        durationMs: result.durationMs ?? 0,
        sessionId: result.sessionId ?? null,
      });
      if (!completed) {
        console.error(chalk.red(`Message ${msgId} ledger transition to completed failed (possible concurrent invocation or state drift).`));
        db.close();
        process.exit(1);
      }

      // Track resume failure
      if (resumeFailed) {
        store.incrementResumeFailCount(debateId, 'critic');
      }

      // Update unified session with thread ID and token usage
      if (result.sessionId) {
        sessionMgr.updateThreadId(unifiedSession.id, result.sessionId);
      }
      sessionMgr.addUsageFromResult(unifiedSession.id, result.usage, prompt, result.text);

      // Record event in session audit trail
      sessionMgr.recordEvent({
        sessionId: unifiedSession.id,
        command: 'debate',
        subcommand: 'turn',
        promptPreview: prompt.slice(0, 500),
        responsePreview: result.text.slice(0, 500),
        promptFull: prompt,
        responseFull: result.text,
        usageJson: JSON.stringify(result.usage),
        durationMs: result.durationMs,
        codexThreadId: result.sessionId,
      });

      // Persist session state in debate_turns (legacy mirror)
      store.upsert({
        debateId,
        role: 'critic',
        codexSessionId: result.sessionId ?? existingSessionId,
        round: newRound,
        status: 'active',
      });

      // Update proposer state with resume stats (defensive for older state_json without resumeStats)
      const proposerState = store.loadState(debateId, 'proposer');
      if (proposerState) {
        const stats = proposerState.resumeStats ?? { attempted: 0, succeeded: 0, fallbacks: 0 };
        if (attemptedResume) stats.attempted++;
        if (resumed) stats.succeeded++;
        if (resumeFailed) stats.fallbacks++;
        proposerState.resumeStats = stats;
        store.saveState(debateId, 'proposer', proposerState);
      }

      // Output JSON for the /debate skill to parse
      const output = {
        debateId,
        round: newRound,
        response: result.text.slice(0, 2000),
        responseTruncated: result.text.length > 2000,
        sessionId: result.sessionId,
        resumed,
        cached: false,
        stance: verdict.stance,
        usage: result.usage,
        durationMs: result.durationMs,
      };
      // Human-readable summary on stderr
      const stanceColor = verdict.stance === 'SUPPORT' ? chalk.green :
        verdict.stance === 'OPPOSE' ? chalk.red : chalk.yellow;
      console.error(stanceColor(`\nRound ${newRound} — Stance: ${verdict.stance}`));
      // Show first 3 meaningful lines of the response
      const previewLines = result.text.split('\n').filter(l => l.trim().length > 10).slice(0, 3);
      for (const line of previewLines) {
        console.error(chalk.dim(`  ${line.trim().slice(0, 120)}`));
      }
      console.error(chalk.dim(`Duration: ${(result.durationMs / 1000).toFixed(1)}s | Tokens: ${result.usage?.totalTokens ?? '?'} | Resumed: ${resumed}`));

      console.log(JSON.stringify(output, null, 2));
    } catch (error) {
      // Mark failed in message ledger
      msgStore.markFailed(msgId, error instanceof Error ? error.message : String(error));
      throw error;
    }

    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot debate status ──

export async function debateStatusCommand(debateId: string): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const store = new DebateStore(db);

    const turns = store.getByDebateId(debateId);
    if (turns.length === 0) {
      db.close();
      console.error(chalk.red(`No debate found with ID: ${debateId}`));
      process.exit(1);
    }

    const state = store.loadState(debateId, 'proposer');
    const msgStore = new MessageStore(db);
    const msgHistory = msgStore.getHistory(debateId);
    const tokenStatus = getTokenBudgetStatus(msgHistory, 400_000);

    const output = {
      debateId,
      topic: state?.question ?? 'unknown',
      status: turns.some((t: DebateTurnRow) => t.status === 'active') ? 'active' : turns[0].status,
      round: Math.max(...turns.map((t: DebateTurnRow) => t.round)),
      participants: turns.map((t: DebateTurnRow) => ({
        role: t.role,
        codexSessionId: t.codexSessionId,
        round: t.round,
        status: t.status,
        resumeFailCount: t.resumeFailCount,
        lastActivity: new Date(t.lastActivityAt).toISOString(),
      })),
      resumeStats: state?.resumeStats ?? null,
      tokenBudget: {
        used: tokenStatus.totalTokensUsed,
        max: tokenStatus.maxContextTokens,
        utilization: `${Math.round(tokenStatus.utilizationRatio * 100)}%`,
        messages: msgHistory.length,
      },
    };
    console.log(JSON.stringify(output, null, 2));

    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot debate list ──

interface ListOptions {
  status?: string;
  limit?: number;
}

export async function debateListCommand(options: ListOptions): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const store = new DebateStore(db);

    const desiredLimit = options.limit ?? 20;
    // Fetch extra rows since each debate has ~2 participant rows; limit after grouping
    const rows = store.list({
      status: options.status as 'active' | 'completed' | undefined,
      limit: desiredLimit * 3,
    });

    // Group by debate_id
    const debates = new Map<string, typeof rows>();
    for (const row of rows) {
      const existing = debates.get(row.debateId) ?? [];
      existing.push(row);
      debates.set(row.debateId, existing);
    }

    const output = Array.from(debates.entries()).slice(0, desiredLimit).map(([id, turns]) => {
      const state = store.loadState(id, 'proposer');
      return {
        debateId: id,
        topic: state?.question ?? 'unknown',
        status: turns.some((t: DebateTurnRow) => t.status === 'active') ? 'active' : turns[0].status,
        round: Math.max(...turns.map((t: DebateTurnRow) => t.round)),
        lastActivity: new Date(Math.max(...turns.map((t: DebateTurnRow) => t.lastActivityAt))).toISOString(),
      };
    });

    console.log(JSON.stringify(output, null, 2));

    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot debate history ──

export async function debateHistoryCommand(debateId: string): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const msgStore = new MessageStore(db);

    const history = msgStore.getHistory(debateId);
    if (history.length === 0) {
      // Check if the debate exists but predates message persistence (Phase 1)
      const debateStore = new DebateStore(db);
      const turns = debateStore.getByDebateId(debateId);
      if (turns.length > 0) {
        console.error(chalk.yellow(`No messages stored for debate ${debateId} — this debate predates message persistence (schema v4). Only metadata is available via "debate status".`));
      } else {
        console.error(chalk.red(`No debate found with ID: ${debateId}`));
      }
      db.close();
      process.exit(1);
    }

    const tokenStatus = getTokenBudgetStatus(history, 400_000);

    const output = {
      debateId,
      messageCount: history.length,
      tokenBudget: {
        used: tokenStatus.totalTokensUsed,
        max: tokenStatus.maxContextTokens,
        utilization: `${Math.round(tokenStatus.utilizationRatio * 100)}%`,
      },
      messages: history.map(m => ({
        round: m.round,
        role: m.role,
        bridge: m.bridge,
        model: m.model,
        status: m.status,
        stance: m.stance,
        confidence: m.confidence,
        durationMs: m.durationMs,
        sessionId: m.sessionId,
        promptPreview: m.promptText.slice(0, 200),
        responsePreview: m.responseText?.slice(0, 200) ?? null,
        error: m.error,
        createdAt: new Date(m.createdAt).toISOString(),
        completedAt: m.completedAt ? new Date(m.completedAt).toISOString() : null,
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

// ── codemoot debate complete ──

export async function debateCompleteCommand(debateId: string): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const store = new DebateStore(db);

    const turns = store.getByDebateId(debateId);
    if (turns.length === 0) {
      console.error(chalk.red(`No debate found with ID: ${debateId}`));
      db.close();
      process.exit(1);
    }

    const completeTransaction = db.transaction(() => {
      store.updateStatus(debateId, 'proposer', 'completed');
      store.updateStatus(debateId, 'critic', 'completed');
    });
    completeTransaction();

    console.log(JSON.stringify({ debateId, status: 'completed' }));
    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

