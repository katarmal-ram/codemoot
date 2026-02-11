// packages/core/src/memory/cost-store.ts

import type Database from 'better-sqlite3';
import type { CostLogEntry } from '../types/memory.js';

export interface CostSummary {
  modelId: string;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  avgLatencyMs: number;
}

export class CostStore {
  constructor(private db: Database.Database) {}

  log(entry: Omit<CostLogEntry, 'id' | 'createdAt'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO cost_log (session_id, step_id, model_id, input_tokens, output_tokens, cost_usd, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.sessionId,
        entry.stepId,
        entry.modelId,
        entry.inputTokens,
        entry.outputTokens,
        entry.costUsd,
        entry.latencyMs,
      );
    return result.lastInsertRowid as number;
  }

  getBySession(sessionId: string): CostLogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM cost_log WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntry(r));
  }

  getSessionSummary(sessionId: string): CostSummary[] {
    const rows = this.db
      .prepare(
        `SELECT model_id, COUNT(*) AS call_count,
        SUM(input_tokens) AS total_input_tokens,
        SUM(output_tokens) AS total_output_tokens,
        SUM(cost_usd) AS total_cost,
        AVG(latency_ms) AS avg_latency_ms
      FROM cost_log WHERE session_id = ?
      GROUP BY model_id ORDER BY total_cost DESC`,
      )
      .all(sessionId) as Record<string, unknown>[];

    return rows.map((r) => ({
      modelId: r.model_id as string,
      callCount: r.call_count as number,
      totalInputTokens: r.total_input_tokens as number,
      totalOutputTokens: r.total_output_tokens as number,
      totalCost: r.total_cost as number,
      avgLatencyMs: r.avg_latency_ms as number,
    }));
  }

  getDailySummary(days = 30): Record<string, unknown>[] {
    return this.db
      .prepare(
        `SELECT DATE(created_at) AS day, model_id,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cost_usd) AS cost, COUNT(*) AS api_calls
      FROM cost_log WHERE created_at >= DATE('now', ? || ' days')
      GROUP BY day, model_id ORDER BY day DESC, cost DESC`,
      )
      .all(`-${days}`) as Record<string, unknown>[];
  }

  private rowToEntry(row: Record<string, unknown>): CostLogEntry {
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      stepId: (row.step_id as string) ?? null,
      modelId: row.model_id as string,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      costUsd: row.cost_usd as number,
      latencyMs: row.latency_ms as number,
      createdAt: row.created_at as string,
    };
  }
}
