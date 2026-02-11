// packages/cli/src/commands/session.ts — Unified session CLI commands

import { SessionManager } from '@codemoot/core';
import chalk from 'chalk';

import { withDatabase } from '../utils.js';

// ── codemoot session start ──

interface StartOptions {
  name?: string;
}

export async function sessionStartCommand(options: StartOptions): Promise<void> {
  await withDatabase(async (db) => {
    const mgr = new SessionManager(db);
    const id = mgr.create(options.name);
    const session = mgr.get(id);

    mgr.recordEvent({
      sessionId: id,
      command: 'session',
      subcommand: 'start',
      promptPreview: `Session started: ${session?.name ?? id}`,
    });

    console.log(JSON.stringify({
      sessionId: id,
      name: session?.name ?? null,
      status: 'active',
      message: 'Session created. All GPT commands will now use this session.',
    }, null, 2));
  });
}

// ── codemoot session current ──

export async function sessionCurrentCommand(): Promise<void> {
  await withDatabase(async (db) => {
    const mgr = new SessionManager(db);
    const session = mgr.getActive();
    if (!session) {
      console.log(JSON.stringify({ active: false, message: 'No active session. Run "codemoot session start" to create one.' }));
      return;
    }

    const events = mgr.getEvents(session.id, 5);
    const overflow = mgr.getOverflowStatus(session.id);

    console.log(JSON.stringify({
      sessionId: session.id,
      name: session.name,
      codexThreadId: session.codexThreadId,
      status: session.status,
      tokenBudget: {
        used: overflow.cumulativeTokens,
        lastTurnInput: overflow.lastTurnInputTokens,
        max: overflow.maxContext,
        utilization: `${Math.round(overflow.utilizationRatio * 100)}%`,
      },
      recentEvents: events.map(e => ({
        command: e.command,
        subcommand: e.subcommand,
        durationMs: e.durationMs,
        createdAt: new Date(e.createdAt).toISOString(),
      })),
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
    }, null, 2));
  });
}

// ── codemoot session list ──

interface ListOptions {
  status?: string;
  limit?: number;
}

export async function sessionListCommand(options: ListOptions): Promise<void> {
  await withDatabase(async (db) => {
    const mgr = new SessionManager(db);
    const sessions = mgr.list({
      status: options.status,
      limit: options.limit ?? 20,
    });

    const output = sessions.map(s => ({
      sessionId: s.id,
      name: s.name,
      status: s.status,
      codexThreadId: s.codexThreadId ? `${s.codexThreadId.slice(0, 12)}...` : null,
      tokenUsage: s.tokenUsage,
      createdAt: new Date(s.createdAt).toISOString(),
      updatedAt: new Date(s.updatedAt).toISOString(),
    }));

    console.log(JSON.stringify(output, null, 2));
  });
}

// ── codemoot session status ──

export async function sessionStatusCommand(sessionId: string): Promise<void> {
  await withDatabase(async (db) => {
    const mgr = new SessionManager(db);
    const session = mgr.get(sessionId);
    if (!session) {
      console.error(chalk.red(`No session found with ID: ${sessionId}`));
      process.exit(1);
    }

    const events = mgr.getEvents(sessionId, 20);
    const overflow = mgr.getOverflowStatus(sessionId);

    console.log(JSON.stringify({
      sessionId: session.id,
      name: session.name,
      codexThreadId: session.codexThreadId,
      status: session.status,
      tokenBudget: {
        used: overflow.cumulativeTokens,
        lastTurnInput: overflow.lastTurnInputTokens,
        max: overflow.maxContext,
        utilization: `${Math.round(overflow.utilizationRatio * 100)}%`,
        shouldWarn: overflow.shouldWarn,
        shouldReconstruct: overflow.shouldReconstruct,
      },
      eventCount: events.length,
      events: events.map(e => ({
        command: e.command,
        subcommand: e.subcommand,
        promptPreview: e.promptPreview,
        responsePreview: e.responsePreview,
        durationMs: e.durationMs,
        createdAt: new Date(e.createdAt).toISOString(),
      })),
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString(),
      completedAt: session.completedAt ? new Date(session.completedAt).toISOString() : null,
    }, null, 2));
  });
}

// ── codemoot session close ──

export async function sessionCloseCommand(sessionId: string): Promise<void> {
  await withDatabase(async (db) => {
    const mgr = new SessionManager(db);
    const session = mgr.get(sessionId);
    if (!session) {
      console.error(chalk.red(`No session found with ID: ${sessionId}`));
      process.exit(1);
    }

    mgr.complete(sessionId);
    console.log(JSON.stringify({ sessionId, status: 'completed' }));
  });
}
