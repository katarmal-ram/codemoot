// packages/core/src/memory/session-store.ts

import type Database from 'better-sqlite3';
import type { ExecutionMode, ProjectConfig } from '../types/config.js';
import type { Session, SessionStatus, TranscriptEntry } from '../types/session.js';
import { generateSessionId } from '../utils/id.js';

export class SessionStore {
  constructor(private db: Database.Database) {}

  create(params: {
    projectId: string;
    workflowId: string;
    task: string;
    mode: ExecutionMode;
    config: ProjectConfig;
  }): Session {
    const id = generateSessionId();
    const now = new Date().toISOString();
    const configSnapshot = JSON.stringify(params.config);

    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, task, workflow_id, mode, status, config_snapshot, started_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, '{}')`,
      )
      .run(
        id,
        params.projectId,
        params.task,
        params.workflowId,
        params.mode,
        configSnapshot,
        now,
        now,
      );

    return {
      id,
      projectId: params.projectId,
      workflowId: params.workflowId,
      task: params.task,
      status: 'running',
      mode: params.mode,
      currentStep: null,
      configSnapshot,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      summary: null,
      totalCost: 0,
      totalTokens: 0,
      metadata: {},
    };
  }

  get(sessionId: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToSession(row) : null;
  }

  list(filter?: { status?: SessionStatus; projectId?: string; limit?: number }): Session[] {
    let sql = 'SELECT * FROM sessions WHERE 1=1';
    const params: unknown[] = [];

    if (filter?.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }
    if (filter?.projectId) {
      sql += ' AND project_id = ?';
      params.push(filter.projectId);
    }
    sql += ' ORDER BY started_at DESC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.rowToSession(r));
  }

  updateStatus(sessionId: string, status: SessionStatus): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, sessionId);
  }

  updateCurrentStep(sessionId: string, stepId: string): void {
    this.db
      .prepare("UPDATE sessions SET current_step = ?, updated_at = datetime('now') WHERE id = ?")
      .run(stepId, sessionId);
  }

  complete(sessionId: string, summary?: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET status = 'completed', summary = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      )
      .run(summary ?? null, sessionId);
  }

  addUsage(sessionId: string, cost: number, tokens: number): void {
    this.db
      .prepare(
        `UPDATE sessions SET total_cost = total_cost + ?, total_tokens = total_tokens + ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(cost, tokens, sessionId);
  }

  saveTranscriptEntry(entry: TranscriptEntry): void {
    this.db
      .prepare(
        `INSERT INTO messages (session_id, step_id, iteration, role, model_id, content, token_count, cost, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.sessionId,
        entry.stepId,
        entry.iteration,
        entry.role,
        entry.modelId,
        entry.content,
        entry.tokenCount,
        entry.cost,
        entry.createdAt || new Date().toISOString(),
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      );
  }

  getTranscript(sessionId: string): TranscriptEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r.id as number,
      sessionId: r.session_id as string,
      stepId: r.step_id as string,
      iteration: (r.iteration as number) ?? null,
      role: r.role as string,
      modelId: (r.model_id as string) ?? null,
      content: r.content as string,
      tokenCount: (r.token_count as number) ?? null,
      cost: (r.cost as number) ?? null,
      createdAt: r.created_at as string,
      metadata: r.metadata ? (JSON.parse(r.metadata as string) as Record<string, unknown>) : null,
    }));
  }

  private rowToSession(row: Record<string, unknown>): Session {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      workflowId: row.workflow_id as string,
      task: row.task as string,
      status: row.status as SessionStatus,
      mode: row.mode as ExecutionMode,
      currentStep: (row.current_step as string) ?? null,
      configSnapshot: (row.config_snapshot as string) ?? '',
      startedAt: row.started_at as string,
      updatedAt: row.updated_at as string,
      completedAt: (row.completed_at as string) ?? null,
      summary: (row.summary as string) ?? null,
      totalCost: (row.total_cost as number) ?? 0,
      totalTokens: (row.total_tokens as number) ?? 0,
      metadata: row.metadata ? (JSON.parse(row.metadata as string) as Record<string, unknown>) : {},
    };
  }
}
