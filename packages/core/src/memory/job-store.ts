// packages/core/src/memory/job-store.ts — SQLite-backed job queue for background async work

import type Database from 'better-sqlite3';
import type { EnqueueOptions, JobLogRecord, JobRecord, JobStatus, JobType } from '../types/jobs.js';
import { generateId } from '../utils/id.js';

export class JobStore {
  constructor(private db: Database.Database) {}

  /** Enqueue a new job. Returns the job ID. */
  enqueue(options: EnqueueOptions): string {
    const id = generateId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO jobs (id, type, status, priority, dedupe_key, payload_json, max_retries, session_id, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        options.type,
        options.priority ?? 100,
        options.dedupeKey ?? null,
        JSON.stringify(options.payload),
        options.maxRetries ?? 1,
        options.sessionId ?? null,
        now,
        now,
      );
    return id;
  }

  /** Get a job by ID. */
  get(id: string): JobRecord | null {
    const row = this.db
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toJob(row) : null;
  }

  /** Atomically claim the next N queued jobs. Returns claimed jobs. */
  claimNext(workerId: string, limit = 1): JobRecord[] {
    const now = Date.now();
    // Two-step: select then update (SQLite doesn't support UPDATE...RETURNING with ORDER BY LIMIT)
    const rows = this.db
      .prepare(
        `SELECT id FROM jobs WHERE status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT ?`,
      )
      .all(limit) as { id: string }[];

    if (rows.length === 0) return [];

    const claimed: JobRecord[] = [];
    const claimStmt = this.db.prepare(
      `UPDATE jobs SET status = 'running', worker_id = ?, started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`,
    );

    for (const row of rows) {
      const result = claimStmt.run(workerId, now, now, row.id);
      if (result.changes > 0) {
        const job = this.get(row.id);
        if (job) claimed.push(job);
      }
    }
    return claimed;
  }

  /** Mark a job as succeeded. Only updates if still running (not canceled). */
  succeed(id: string, result: Record<string, unknown>): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'succeeded', result_json = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
      )
      .run(JSON.stringify(result), now, now, id);
  }

  /** Mark a job as failed. Only updates if still running (not canceled). */
  fail(id: string, error: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'failed', error_text = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
      )
      .run(error, now, now, id);
  }

  /** Cancel a job. */
  cancel(id: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'canceled', finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(now, now, id);
  }

  /** Retry a failed/canceled job. */
  retry(id: string): boolean {
    const job = this.get(id);
    if (!job) return false;
    if (job.status !== 'failed' && job.status !== 'canceled') return false;
    if (job.retryCount >= job.maxRetries) return false;

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', retry_count = retry_count + 1, error_text = NULL, result_json = NULL, worker_id = NULL, started_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(now, id);
    return true;
  }

  /** List jobs with optional filters. */
  list(options?: { status?: JobStatus; type?: JobType; limit?: number }): JobRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options?.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options?.limit ?? 50;
    params.push(limit);

    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];

    return rows.map(r => this.toJob(r));
  }

  /** Check if a dedupe key already has an active (queued/running) job. */
  hasActive(dedupeKey: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running') LIMIT 1`)
      .get(dedupeKey);
    return Boolean(row);
  }

  /** Check if any active job exists for a given type. */
  hasActiveByType(type: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM jobs WHERE type = ? AND status IN ('queued', 'running') LIMIT 1`)
      .get(type);
    return Boolean(row);
  }

  // ── Job Logs ──

  /** Append a log entry. */
  appendLog(jobId: string, level: JobLogRecord['level'], eventType: string, message?: string, payload?: Record<string, unknown>): void {
    const maxSeq = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM job_logs WHERE job_id = ?')
      .get(jobId) as { max_seq: number };

    this.db
      .prepare(
        `INSERT INTO job_logs (job_id, seq, level, event_type, message, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(jobId, maxSeq.max_seq + 1, level, eventType, message ?? null, payload ? JSON.stringify(payload) : null, Date.now());
  }

  /** Get logs for a job. */
  getLogs(jobId: string, fromSeq = 0, limit = 100): JobLogRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM job_logs WHERE job_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(jobId, fromSeq, limit) as Record<string, unknown>[];

    return rows.map(r => ({
      id: r.id as number,
      jobId: r.job_id as string,
      seq: r.seq as number,
      level: r.level as JobLogRecord['level'],
      eventType: r.event_type as string,
      message: (r.message as string) ?? null,
      payloadJson: (r.payload_json as string) ?? null,
      createdAt: r.created_at as number,
    }));
  }

  private toJob(row: Record<string, unknown>): JobRecord {
    return {
      id: row.id as string,
      type: row.type as JobType,
      status: row.status as JobStatus,
      priority: row.priority as number,
      dedupeKey: (row.dedupe_key as string) ?? null,
      payloadJson: row.payload_json as string,
      resultJson: (row.result_json as string) ?? null,
      errorText: (row.error_text as string) ?? null,
      retryCount: row.retry_count as number,
      maxRetries: row.max_retries as number,
      sessionId: (row.session_id as string) ?? null,
      workerId: (row.worker_id as string) ?? null,
      startedAt: (row.started_at as number) ?? null,
      finishedAt: (row.finished_at as number) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
