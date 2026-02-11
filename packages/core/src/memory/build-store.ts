// packages/core/src/memory/build-store.ts — CRUD for build_runs + build_events

import type Database from 'better-sqlite3';
import type {
  BuildActor,
  BuildEvent,
  BuildEventType,
  BuildPhase,
  BuildRun,
  BuildStatus,
  BuildSummary,
  PhaseCursor,
} from '../types/build.js';

export class BuildStore {
  constructor(private db: Database.Database) {}

  /** Create a new build run. */
  create(params: {
    buildId: string;
    task: string;
    debateId?: string;
    baselineRef?: string;
  }): void {
    const now = Date.now();
    const cursor: PhaseCursor = {
      phase: 'debate',
      loop: 0,
      actor: 'system',
      attempt: 0,
      lastEventId: 0,
    };
    this.db
      .prepare(
        `INSERT INTO build_runs (build_id, task, status, current_phase, current_loop, last_event_seq, phase_cursor, debate_id, baseline_ref, created_at, updated_at)
         VALUES (?, ?, 'planning', 'debate', 0, 0, ?, ?, ?, ?, ?)`,
      )
      .run(params.buildId, params.task, JSON.stringify(cursor), params.debateId ?? null, params.baselineRef ?? null, now, now);
  }

  /** Get a build run by build_id. */
  get(buildId: string): BuildRun | null {
    const row = this.db
      .prepare('SELECT * FROM build_runs WHERE build_id = ?')
      .get(buildId) as Record<string, unknown> | undefined;
    return row ? this.toRun(row) : null;
  }

  /** List builds, optionally filtered by status. */
  list(filter?: { status?: BuildStatus; limit?: number }): BuildSummary[] {
    let sql = 'SELECT * FROM build_runs WHERE 1=1';
    const params: unknown[] = [];
    if (filter?.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY updated_at DESC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      buildId: r.build_id as string,
      task: r.task as string,
      status: r.status as BuildStatus,
      phase: r.current_phase as BuildPhase,
      loop: r.current_loop as number,
      reviewCycles: (r.review_cycles as number) ?? 0,
      planVersion: (r.plan_version as number) ?? 0,
      debateId: (r.debate_id as string) ?? null,
      baselineRef: (r.baseline_ref as string) ?? null,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
    }));
  }

  /** Update build run fields atomically with event append. */
  updateWithEvent(
    buildId: string,
    updates: Partial<{
      status: BuildStatus;
      currentPhase: BuildPhase;
      currentLoop: number;
      debateId: string;
      baselineRef: string;
      planCodexSession: string;
      reviewCodexSession: string;
      planVersion: number;
      reviewCycles: number;
      completedAt: number;
      metadata: Record<string, unknown>;
    }>,
    event: {
      eventType: BuildEventType;
      actor: BuildActor;
      phase: BuildPhase;
      loopIndex?: number;
      payload?: Record<string, unknown>;
      codexThreadId?: string;
      tokensUsed?: number;
    },
  ): void {
    this.db.transaction(() => {
      // Get next seq
      const run = this.get(buildId);
      if (!run) throw new Error(`Build not found: ${buildId}`);
      const nextSeq = run.lastEventSeq + 1;
      const now = Date.now();

      // Insert event
      this.db
        .prepare(
          `INSERT INTO build_events (build_id, seq, event_type, actor, phase, loop_index, payload, codex_thread_id, tokens_used, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          buildId,
          nextSeq,
          event.eventType,
          event.actor,
          event.phase,
          event.loopIndex ?? 0,
          event.payload ? JSON.stringify(event.payload) : null,
          event.codexThreadId ?? null,
          event.tokensUsed ?? 0,
          now,
        );

      // Build SET clause dynamically
      const sets: string[] = ['last_event_seq = ?', 'updated_at = ?'];
      const values: unknown[] = [nextSeq, now];

      if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
      if (updates.currentPhase !== undefined) { sets.push('current_phase = ?'); values.push(updates.currentPhase); }
      if (updates.currentLoop !== undefined) { sets.push('current_loop = ?'); values.push(updates.currentLoop); }
      if (updates.debateId !== undefined) { sets.push('debate_id = ?'); values.push(updates.debateId); }
      if (updates.baselineRef !== undefined) { sets.push('baseline_ref = ?'); values.push(updates.baselineRef); }
      if (updates.planCodexSession !== undefined) { sets.push('plan_codex_session = ?'); values.push(updates.planCodexSession); }
      if (updates.reviewCodexSession !== undefined) { sets.push('review_codex_session = ?'); values.push(updates.reviewCodexSession); }
      if (updates.planVersion !== undefined) { sets.push('plan_version = ?'); values.push(updates.planVersion); }
      if (updates.reviewCycles !== undefined) { sets.push('review_cycles = ?'); values.push(updates.reviewCycles); }
      if (updates.completedAt !== undefined) { sets.push('completed_at = ?'); values.push(updates.completedAt); }
      if (updates.metadata !== undefined) { sets.push('metadata = ?'); values.push(JSON.stringify(updates.metadata)); }

      // Update cursor
      const cursor: PhaseCursor = {
        phase: updates.currentPhase ?? run.currentPhase,
        loop: updates.currentLoop ?? run.currentLoop,
        actor: event.actor,
        attempt: 0,
        lastEventId: nextSeq,
        baselineRef: updates.baselineRef ?? run.baselineRef ?? undefined,
      };
      sets.push('phase_cursor = ?');
      values.push(JSON.stringify(cursor));

      values.push(buildId);
      this.db.prepare(`UPDATE build_runs SET ${sets.join(', ')} WHERE build_id = ?`).run(...values);
    })();
  }

  /** Get events for a build, ordered by seq. */
  getEvents(buildId: string, afterSeq?: number): BuildEvent[] {
    let sql = 'SELECT * FROM build_events WHERE build_id = ?';
    const params: unknown[] = [buildId];
    if (afterSeq !== undefined) {
      sql += ' AND seq > ?';
      params.push(afterSeq);
    }
    sql += ' ORDER BY seq ASC';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.toEvent(r));
  }

  /** Count events by type for a build. */
  countEventsByType(buildId: string, eventType: BuildEventType): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as cnt FROM build_events WHERE build_id = ? AND event_type = ?')
      .get(buildId, eventType) as { cnt: number };
    return row.cnt;
  }

  private toRun(row: Record<string, unknown>): BuildRun {
    let cursor: PhaseCursor;
    try {
      cursor = JSON.parse((row.phase_cursor as string) || '{}');
    } catch {
      cursor = { phase: 'debate', loop: 0, actor: 'system', attempt: 0, lastEventId: 0 };
    }
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata) {
      try { metadata = JSON.parse(row.metadata as string); } catch { /* ignore */ }
    }
    return {
      id: row.id as number,
      buildId: row.build_id as string,
      task: row.task as string,
      status: row.status as BuildStatus,
      currentPhase: row.current_phase as BuildPhase,
      currentLoop: (row.current_loop as number) ?? 0,
      lastEventSeq: (row.last_event_seq as number) ?? 0,
      phaseCursor: cursor,
      debateId: (row.debate_id as string) ?? null,
      baselineRef: (row.baseline_ref as string) ?? null,
      planCodexSession: (row.plan_codex_session as string) ?? null,
      reviewCodexSession: (row.review_codex_session as string) ?? null,
      planVersion: (row.plan_version as number) ?? 0,
      reviewCycles: (row.review_cycles as number) ?? 0,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      completedAt: (row.completed_at as number) ?? null,
      metadata,
    };
  }

  private toEvent(row: Record<string, unknown>): BuildEvent {
    let payload: Record<string, unknown> | null = null;
    if (row.payload) {
      try { payload = JSON.parse(row.payload as string); } catch { /* ignore */ }
    }
    return {
      id: row.id as number,
      buildId: row.build_id as string,
      seq: row.seq as number,
      eventType: row.event_type as BuildEventType,
      actor: row.actor as BuildActor,
      phase: row.phase as BuildPhase,
      loopIndex: (row.loop_index as number) ?? 0,
      payload,
      codexThreadId: (row.codex_thread_id as string) ?? null,
      tokensUsed: (row.tokens_used as number) ?? 0,
      createdAt: row.created_at as number,
    };
  }
}
