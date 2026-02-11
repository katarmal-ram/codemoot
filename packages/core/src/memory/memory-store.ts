// packages/core/src/memory/memory-store.ts

import type Database from 'better-sqlite3';
import type { MemoryCategory, MemoryRecord } from '../types/memory.js';

export class MemoryStore {
  constructor(private db: Database.Database) {}

  save(memory: Omit<MemoryRecord, 'id' | 'createdAt' | 'accessedAt' | 'accessCount'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO memories (project_id, category, content, source_session_id, importance)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        memory.projectId,
        memory.category,
        memory.content,
        memory.sourceSessionId,
        memory.importance,
      );
    return result.lastInsertRowid as number;
  }

  search(query: string, projectId: string, limit = 10): MemoryRecord[] {
    if (!query.trim()) return [];

    // Escape FTS5 special characters by wrapping each token in double quotes
    const sanitized = query
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => `"${token.replace(/"/g, '""')}"`)
      .join(' ');

    const rows = this.db
      .prepare(
        `SELECT m.*, rank
       FROM memories_fts
       JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.project_id = ?
       ORDER BY rank
       LIMIT ?`,
      )
      .all(sanitized, projectId, limit) as Record<string, unknown>[];

    return rows.map((r) => this.rowToMemory(r));
  }

  getByCategory(projectId: string, category: MemoryCategory): MemoryRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM memories WHERE project_id = ? AND category = ? ORDER BY importance DESC',
      )
      .all(projectId, category) as Record<string, unknown>[];

    return rows.map((r) => this.rowToMemory(r));
  }

  getById(memoryId: number): MemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  recordAccess(memoryId: number): void {
    this.db
      .prepare(
        'UPDATE memories SET accessed_at = CURRENT_TIMESTAMP, access_count = access_count + 1 WHERE id = ?',
      )
      .run(memoryId);
  }

  /** Check if a memory with matching category and content prefix already exists. */
  findByPrefix(projectId: string, category: string, contentPrefix: string): MemoryRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM memories WHERE project_id = ? AND category = ? AND content LIKE ? LIMIT 1',
      )
      .get(projectId, category, `${contentPrefix}%`) as Record<string, unknown> | undefined;
    return row ? this.rowToMemory(row) : null;
  }

  delete(memoryId: number): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
  }

  private rowToMemory(row: Record<string, unknown>): MemoryRecord {
    return {
      id: row.id as number,
      projectId: row.project_id as string,
      category: row.category as MemoryCategory,
      content: row.content as string,
      sourceSessionId: (row.source_session_id as string) ?? null,
      importance: row.importance as number,
      createdAt: row.created_at as string,
      accessedAt: row.accessed_at as string,
      accessCount: row.access_count as number,
    };
  }
}
