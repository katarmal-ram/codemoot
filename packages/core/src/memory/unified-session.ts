// packages/core/src/memory/unified-session.ts — Unified session management

import type Database from 'better-sqlite3';
import { generateId } from '../utils/id.js';
import { sanitize } from '../security/dlp.js';
import { estimateTokens } from './token-budget.js';

export interface UnifiedSession {
  id: string;
  name: string | null;
  codexThreadId: string | null;
  status: 'active' | 'completed' | 'stale';
  tokenUsage: number;
  maxContext: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface SessionEvent {
  id: number;
  sessionId: string;
  command: string;
  subcommand: string | null;
  promptPreview: string | null;
  responsePreview: string | null;
  usageJson: string | null;
  durationMs: number | null;
  codexThreadId: string | null;
  createdAt: number;
}

export interface SessionOverflowStatus {
  /** Cumulative tokens (for cost tracking). */
  cumulativeTokens: number;
  /** Latest turn's input_tokens (best proxy for current context fullness). */
  lastTurnInputTokens: number;
  maxContext: number;
  /** Based on lastTurnInputTokens / maxContext. */
  utilizationRatio: number;
  shouldWarn: boolean;      // > 75%
  shouldReconstruct: boolean; // > 85%
}

export class SessionManager {
  constructor(private db: Database.Database) {}

  /** Create a new session. Returns the session ID. */
  create(name?: string): string {
    const id = generateId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO codemoot_sessions (id, name, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`,
      )
      .run(id, name ?? null, now, now);
    return id;
  }

  /** Get a session by ID. */
  get(id: string): UnifiedSession | null {
    const row = this.db
      .prepare('SELECT * FROM codemoot_sessions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toSession(row) : null;
  }

  /** Get the current active session (most recently updated). */
  getActive(): UnifiedSession | null {
    const row = this.db
      .prepare("SELECT * FROM codemoot_sessions WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return row ? this.toSession(row) : null;
  }

  /** Get or create the active session. If none exists, auto-create one. */
  resolveActive(autoName?: string): UnifiedSession {
    const existing = this.getActive();
    if (existing) return existing;
    const id = this.create(autoName);
    return this.get(id) as UnifiedSession;
  }

  /** Update the codex thread ID for a session (after first GPT call). */
  updateThreadId(sessionId: string, threadId: string): void {
    this.db
      .prepare(
        'UPDATE codemoot_sessions SET codex_thread_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(threadId, Date.now(), sessionId);
  }

  /** Update token usage for a session. Ignores negative values. */
  addTokenUsage(sessionId: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    tokens = Math.floor(tokens);
    this.db
      .prepare(
        'UPDATE codemoot_sessions SET token_usage = token_usage + ?, updated_at = ? WHERE id = ?',
      )
      .run(tokens, Date.now(), sessionId);
  }

  /**
   * Add token usage from a model call result. Uses real usage when available,
   * falls back to char/4 estimate only when usage data is missing.
   */
  addUsageFromResult(sessionId: string, usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number }, promptText?: string, responseText?: string): void {
    const realTokens = usage.totalTokens || ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
    if (realTokens > 0) {
      this.addTokenUsage(sessionId, realTokens);
    } else if (promptText || responseText) {
      this.addTokenUsage(sessionId, this.estimateEventTokens(promptText ?? '', responseText ?? ''));
    }
  }

  /** Touch the updated_at timestamp. */
  touch(sessionId: string): void {
    this.db
      .prepare('UPDATE codemoot_sessions SET updated_at = ? WHERE id = ?')
      .run(Date.now(), sessionId);
  }

  /** Mark a session as completed. */
  complete(sessionId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE codemoot_sessions SET status = 'completed', updated_at = ?, completed_at = ? WHERE id = ?",
      )
      .run(now, now, sessionId);
  }

  /** List sessions, optionally filtered by status. */
  list(options?: { status?: string; limit?: number }): UnifiedSession[] {
    const rawLimit = options?.limit ?? 20;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    let sql = 'SELECT * FROM codemoot_sessions';
    const params: unknown[] = [];
    if (options?.status) {
      sql += ' WHERE status = ?';
      params.push(options.status);
    }
    sql += ' ORDER BY updated_at DESC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.toSession(r));
  }

  /** Get overflow status for a session. Uses latest turn's input_tokens as context fullness signal. */
  getOverflowStatus(sessionId: string): SessionOverflowStatus {
    const session = this.get(sessionId);
    if (!session) {
      return { cumulativeTokens: 0, lastTurnInputTokens: 0, maxContext: 400_000, utilizationRatio: 0, shouldWarn: false, shouldReconstruct: false };
    }
    // 128K was the old incorrect default; codex context is 400K
    const maxCtx = (session.maxContext > 0 && session.maxContext !== 128_000) ? session.maxContext : 400_000;

    // Get latest event's input_tokens as best proxy for current context size
    const latestEvents = this.getEvents(sessionId, 1);
    let lastTurnInput = 0;
    if (latestEvents.length > 0 && latestEvents[0].usageJson) {
      try {
        const usage = JSON.parse(latestEvents[0].usageJson);
        const raw = usage.inputTokens ?? usage.input_tokens ?? 0;
        lastTurnInput = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
      } catch { /* malformed JSON */ }
    }

    const ratio = lastTurnInput / maxCtx;
    return {
      cumulativeTokens: session.tokenUsage,
      lastTurnInputTokens: lastTurnInput,
      maxContext: maxCtx,
      utilizationRatio: ratio,
      shouldWarn: ratio > 0.75,
      shouldReconstruct: ratio > 0.85,
    };
  }

  /** Pre-call check: auto-rollover if session context is over threshold. Call before every codex interaction. */
  preCallOverflowCheck(sessionId: string, threshold = 0.85): { rolled: boolean; message?: string } {
    const status = this.getOverflowStatus(sessionId);
    if (status.utilizationRatio > threshold) {
      this.rolloverThread(sessionId);
      const pct = Math.round(status.utilizationRatio * 100);
      return { rolled: true, message: `Session at ${pct}%. Rolling over to new thread.` };
    }
    return { rolled: false };
  }

  /** Roll over to a new codex thread (on context overflow). Returns new thread info. */
  rolloverThread(sessionId: string): void {
    this.db
      .prepare(
        'UPDATE codemoot_sessions SET codex_thread_id = NULL, updated_at = ? WHERE id = ?',
      )
      .run(Date.now(), sessionId);
  }

  // ── Session Events ──

  /** Record a GPT interaction event. Stores preview (500 chars) + optional full text. */
  recordEvent(params: {
    sessionId: string;
    command: string;
    subcommand?: string;
    promptPreview?: string;
    responsePreview?: string;
    promptFull?: string;
    responseFull?: string;
    usageJson?: string;
    durationMs?: number;
    codexThreadId?: string;
  }): number {
    const sanitizedPrompt = params.promptPreview
      ? sanitize(params.promptPreview.slice(0, 500), { mode: 'strict' }).sanitized
      : null;
    const sanitizedResponse = params.responsePreview
      ? sanitize(params.responsePreview.slice(0, 500), { mode: 'strict' }).sanitized
      : null;
    const sanitizedPromptFull = params.promptFull
      ? sanitize(params.promptFull, { mode: 'strict' }).sanitized
      : null;
    const sanitizedResponseFull = params.responseFull
      ? sanitize(params.responseFull, { mode: 'strict' }).sanitized
      : null;

    const result = this.db
      .prepare(
        `INSERT INTO session_events (session_id, command, subcommand, prompt_preview, response_preview, prompt_full, response_full, usage_json, duration_ms, codex_thread_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.sessionId,
        params.command,
        params.subcommand ?? null,
        sanitizedPrompt,
        sanitizedResponse,
        sanitizedPromptFull,
        sanitizedResponseFull,
        params.usageJson ?? null,
        params.durationMs ?? null,
        params.codexThreadId ?? null,
        Date.now(),
      );
    return Number(result.lastInsertRowid);
  }

  /** Get events for a session. */
  getEvents(sessionId: string, rawLimit = 50): SessionEvent[] {
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    const rows = this.db
      .prepare('SELECT * FROM session_events WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(sessionId, limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      command: r.command as string,
      subcommand: (r.subcommand as string) ?? null,
      promptPreview: (r.prompt_preview as string) ?? null,
      responsePreview: (r.response_preview as string) ?? null,
      usageJson: (r.usage_json as string) ?? null,
      durationMs: (r.duration_ms as number) ?? null,
      codexThreadId: (r.codex_thread_id as string) ?? null,
      createdAt: r.created_at as number,
    }));
  }

  /** Estimate tokens from prompt + response text (for usage tracking when real usage unavailable). */
  estimateEventTokens(promptText: string, responseText: string): number {
    return estimateTokens(promptText) + estimateTokens(responseText);
  }

  private toSession(row: Record<string, unknown>): UnifiedSession {
    return {
      id: row.id as string,
      name: (row.name as string) ?? null,
      codexThreadId: (row.codex_thread_id as string) ?? null,
      status: (row.status as UnifiedSession['status']) ?? 'active',
      tokenUsage: (row.token_usage as number) ?? 0,
      maxContext: (row.max_context as number) ?? 400_000,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      completedAt: (row.completed_at as number) ?? null,
    };
  }
}
