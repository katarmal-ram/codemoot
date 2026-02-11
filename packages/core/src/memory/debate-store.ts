// packages/core/src/memory/debate-store.ts — CRUD for debate_turns table

import type Database from 'better-sqlite3';
import type { DebateEngineState } from '../types/debate.js';

export type DebateTurnStatus = 'active' | 'completed' | 'interrupted' | 'stale' | 'expired';

export interface DebateTurnRow {
  id: number;
  debateId: string;
  role: string;
  codexSessionId: string | null;
  round: number;
  status: DebateTurnStatus;
  resumeFailCount: number;
  lastActivityAt: number;
  createdAt: number;
  stateJson: string | null;
}

export class DebateStore {
  constructor(private db: Database.Database) {}

  /** Create or update a debate turn (upsert on debate_id + role). */
  upsert(params: {
    debateId: string;
    role: string;
    codexSessionId?: string;
    round?: number;
    status?: DebateTurnStatus;
    stateJson?: string;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO debate_turns (debate_id, role, codex_session_id, round, status, last_activity_at, created_at, state_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(debate_id, role) DO UPDATE SET
           codex_session_id = COALESCE(excluded.codex_session_id, codex_session_id),
           round = excluded.round,
           status = excluded.status,
           last_activity_at = excluded.last_activity_at,
           state_json = COALESCE(excluded.state_json, state_json)`,
      )
      .run(
        params.debateId,
        params.role,
        params.codexSessionId ?? null,
        params.round ?? 0,
        params.status ?? 'active',
        now,
        now,
        params.stateJson ?? null,
      );
  }

  /** Get a debate turn by debate_id and role. */
  get(debateId: string, role: string): DebateTurnRow | null {
    const row = this.db
      .prepare('SELECT * FROM debate_turns WHERE debate_id = ? AND role = ?')
      .get(debateId, role) as Record<string, unknown> | undefined;
    return row ? this.toRow(row) : null;
  }

  /** Get all turns for a debate. */
  getByDebateId(debateId: string): DebateTurnRow[] {
    const rows = this.db
      .prepare('SELECT * FROM debate_turns WHERE debate_id = ? ORDER BY created_at ASC')
      .all(debateId) as Record<string, unknown>[];
    return rows.map((r) => this.toRow(r));
  }

  /** List debates, optionally filtered by status. */
  list(filter?: { status?: DebateTurnStatus; limit?: number }): DebateTurnRow[] {
    let sql = 'SELECT * FROM debate_turns WHERE 1=1';
    const params: unknown[] = [];

    if (filter?.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY last_activity_at DESC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.toRow(r));
  }

  /** Update session ID after a successful codex call. */
  updateSessionId(debateId: string, role: string, codexSessionId: string): void {
    this.db
      .prepare(
        'UPDATE debate_turns SET codex_session_id = ?, last_activity_at = ? WHERE debate_id = ? AND role = ?',
      )
      .run(codexSessionId, Date.now(), debateId, role);
  }

  /** Update status (e.g., active → completed). */
  updateStatus(debateId: string, role: string, status: DebateTurnStatus): void {
    this.db
      .prepare(
        'UPDATE debate_turns SET status = ?, last_activity_at = ? WHERE debate_id = ? AND role = ?',
      )
      .run(status, Date.now(), debateId, role);
  }

  /** Increment resume failure count. */
  incrementResumeFailCount(debateId: string, role: string): void {
    this.db
      .prepare(
        'UPDATE debate_turns SET resume_fail_count = resume_fail_count + 1, last_activity_at = ? WHERE debate_id = ? AND role = ?',
      )
      .run(Date.now(), debateId, role);
  }

  /** Persist full debate state as JSON for crash recovery. */
  saveState(debateId: string, role: string, state: DebateEngineState): void {
    this.db
      .prepare(
        'UPDATE debate_turns SET state_json = ?, round = ?, last_activity_at = ? WHERE debate_id = ? AND role = ?',
      )
      .run(JSON.stringify(state), state.round, Date.now(), debateId, role);
  }

  /** Load saved debate state from JSON. */
  loadState(debateId: string, role: string): DebateEngineState | null {
    const row = this.get(debateId, role);
    if (!row?.stateJson) return null;
    try {
      return JSON.parse(row.stateJson) as DebateEngineState;
    } catch {
      return null;
    }
  }

  /** Mark stale debates (active but inactive for > threshold). */
  markStale(thresholdMs: number): number {
    const cutoff = Date.now() - thresholdMs;
    const result = this.db
      .prepare(
        "UPDATE debate_turns SET status = 'stale' WHERE status = 'active' AND last_activity_at < ?",
      )
      .run(cutoff);
    return result.changes;
  }

  /** Mark expired debates (stale and older than threshold). */
  markExpired(thresholdMs: number): number {
    const cutoff = Date.now() - thresholdMs;
    const result = this.db
      .prepare(
        "UPDATE debate_turns SET status = 'expired' WHERE status = 'stale' AND last_activity_at < ?",
      )
      .run(cutoff);
    return result.changes;
  }

  private toRow(row: Record<string, unknown>): DebateTurnRow {
    return {
      id: row.id as number,
      debateId: row.debate_id as string,
      role: row.role as string,
      codexSessionId: (row.codex_session_id as string) ?? null,
      round: (row.round as number) ?? 0,
      status: (row.status as DebateTurnStatus) ?? 'active',
      resumeFailCount: (row.resume_fail_count as number) ?? 0,
      lastActivityAt: row.last_activity_at as number,
      createdAt: row.created_at as number,
      stateJson: (row.state_json as string) ?? null,
    };
  }
}
