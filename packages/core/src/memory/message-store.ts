// packages/core/src/memory/message-store.ts — CRUD for debate_messages table

import type Database from 'better-sqlite3';
import { sanitize } from '../security/dlp.js';

export type MessageStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface DebateMessageRow {
  id: number;
  debateId: string;
  round: number;
  role: string;
  bridge: string;
  model: string;
  promptText: string;
  responseText: string | null;
  stance: string | null;
  confidence: number | null;
  verdictRaw: string | null;
  usageJson: string | null;
  durationMs: number | null;
  sessionId: string | null;
  status: MessageStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ParsedVerdict {
  stance: string | null;
  confidence: number | null;
  raw: string | null;
}

const VERDICT_BLOCK_RE = /---VERDICT---([\s\S]*?)---END_VERDICT---/;
const STANCE_RE = /(?:STANCE:\s*|^)(SUPPORT|OPPOSE|UNCERTAIN)(?:\s|[.,:;—\-]|$)/im;

/** Parse structured verdict from model response. */
export function parseDebateVerdict(text: string): ParsedVerdict {
  const VALID_STANCES = new Set(['SUPPORT', 'OPPOSE', 'UNCERTAIN']);

  const validateStance = (s: unknown): string | null => {
    if (typeof s !== 'string') return null;
    const upper = s.toUpperCase();
    return VALID_STANCES.has(upper) ? upper : null;
  };

  const validateConfidence = (c: unknown): number | null => {
    if (typeof c !== 'number' || !Number.isFinite(c)) return null;
    return c >= 0 && c <= 1 ? c : null;
  };

  // Try structured JSON block first
  const blockMatch = VERDICT_BLOCK_RE.exec(text);
  if (blockMatch) {
    try {
      const parsed = JSON.parse(blockMatch[1].trim());
      return {
        stance: validateStance(parsed.stance),
        confidence: validateConfidence(parsed.confidence),
        raw: sanitize(blockMatch[0], { mode: 'strict' }).sanitized,
      };
    } catch {
      // Malformed JSON in block — fall through to regex
    }
  }

  // Fallback to regex
  const stanceMatch = STANCE_RE.exec(text);
  if (stanceMatch) {
    return {
      stance: stanceMatch[1].toUpperCase(),
      confidence: null,
      raw: null,
    };
  }

  return { stance: null, confidence: null, raw: null };
}

export class MessageStore {
  constructor(private db: Database.Database) {}

  /** Insert a new message in queued state. Returns the row ID. */
  insertQueued(params: {
    debateId: string;
    round: number;
    role: string;
    bridge: string;
    model: string;
    promptText: string;
  }): number {
    const now = Date.now();
    const sanitized = sanitize(params.promptText, { mode: 'strict' });
    const result = this.db
      .prepare(
        `INSERT INTO debate_messages (debate_id, round, role, bridge, model, prompt_text, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        params.debateId,
        params.round,
        params.role,
        params.bridge,
        params.model,
        sanitized.sanitized,
        now,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  /** Update prompt text on a queued or failed row (for retries with different prompts). */
  updatePrompt(id: number, promptText: string): boolean {
    const sanitized = sanitize(promptText, { mode: 'strict' });
    const result = this.db
      .prepare(
        `UPDATE debate_messages SET prompt_text = ?, updated_at = ?
         WHERE id = ? AND status IN ('queued', 'failed')`,
      )
      .run(sanitized.sanitized, Date.now(), id);
    return result.changes === 1;
  }

  /** Transition to running. Only from queued or failed. Returns true if transition succeeded. */
  markRunning(id: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE debate_messages SET status = 'running', updated_at = ?
         WHERE id = ? AND status IN ('queued', 'failed')`,
      )
      .run(Date.now(), id);
    return result.changes === 1;
  }

  /** Transition to completed with response data. Only from running. */
  markCompleted(
    id: number,
    params: {
      responseText: string;
      verdict: ParsedVerdict;
      usageJson: string;
      durationMs: number;
      sessionId: string | null;
    },
  ): boolean {
    const now = Date.now();
    const sanitizedResponse = sanitize(params.responseText, { mode: 'strict' });
    const sanitizedError = params.verdict.raw
      ? sanitize(params.verdict.raw, { mode: 'strict' }).sanitized
      : null;
    const result = this.db
      .prepare(
        `UPDATE debate_messages SET
           status = 'completed',
           response_text = ?,
           stance = ?,
           confidence = ?,
           verdict_raw = ?,
           usage_json = ?,
           duration_ms = ?,
           session_id = ?,
           error = NULL,
           updated_at = ?,
           completed_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        sanitizedResponse.sanitized,
        params.verdict.stance,
        params.verdict.confidence,
        sanitizedError,
        params.usageJson,
        params.durationMs,
        params.sessionId,
        now,
        now,
        id,
      );
    return result.changes === 1;
  }

  /** Transition to failed with error. Only from running. */
  markFailed(id: number, error: string): boolean {
    const sanitizedError = sanitize(error, { mode: 'strict' });
    const result = this.db
      .prepare(
        `UPDATE debate_messages SET status = 'failed', error = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(sanitizedError.sanitized, Date.now(), id);
    return result.changes === 1;
  }

  /** Get a message by debate_id, round, and role (for idempotency checks). */
  getByRound(debateId: string, round: number, role: string): DebateMessageRow | null {
    const row = this.db
      .prepare('SELECT * FROM debate_messages WHERE debate_id = ? AND round = ? AND role = ? LIMIT 1')
      .get(debateId, round, role) as Record<string, unknown> | undefined;
    return row ? this.toRow(row) : null;
  }

  /** Get full message history for a debate, ordered by round. */
  getHistory(debateId: string): DebateMessageRow[] {
    const rows = this.db
      .prepare('SELECT * FROM debate_messages WHERE debate_id = ? ORDER BY round ASC, role ASC')
      .all(debateId) as Record<string, unknown>[];
    return rows.map(r => this.toRow(r));
  }

  /** Recover stale running rows older than threshold. Returns count recovered. */
  recoverStale(thresholdMs: number): number {
    const cutoff = Date.now() - thresholdMs;
    const result = this.db
      .prepare(
        `UPDATE debate_messages SET status = 'failed', error = 'STALE_RECOVERY', updated_at = ?
         WHERE status = 'running' AND updated_at < ?`,
      )
      .run(Date.now(), cutoff);
    return result.changes;
  }

  /** Recover stale running rows for a specific debate only. */
  recoverStaleForDebate(debateId: string, thresholdMs: number): number {
    const cutoff = Date.now() - thresholdMs;
    const result = this.db
      .prepare(
        `UPDATE debate_messages SET status = 'failed', error = 'STALE_RECOVERY', updated_at = ?
         WHERE status = 'running' AND debate_id = ? AND updated_at < ?`,
      )
      .run(Date.now(), debateId, cutoff);
    return result.changes;
  }

  private toRow(row: Record<string, unknown>): DebateMessageRow {
    return {
      id: row.id as number,
      debateId: row.debate_id as string,
      round: row.round as number,
      role: row.role as string,
      bridge: (row.bridge as string) ?? 'codex',
      model: row.model as string,
      promptText: row.prompt_text as string,
      responseText: (row.response_text as string) ?? null,
      stance: (row.stance as string) ?? null,
      confidence: (row.confidence as number) ?? null,
      verdictRaw: (row.verdict_raw as string) ?? null,
      usageJson: (row.usage_json as string) ?? null,
      durationMs: (row.duration_ms as number) ?? null,
      sessionId: (row.session_id as string) ?? null,
      status: (row.status as MessageStatus) ?? 'queued',
      error: (row.error as string) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      completedAt: (row.completed_at as number) ?? null,
    };
  }
}
