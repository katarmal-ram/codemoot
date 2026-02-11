// packages/core/src/memory/artifact-store.ts

import type Database from 'better-sqlite3';
import type { ArtifactRecord, ArtifactType } from '../types/memory.js';

export class ArtifactStore {
  constructor(private db: Database.Database) {}

  save(artifact: Omit<ArtifactRecord, 'id' | 'createdAt'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO artifacts (session_id, step_id, iteration, type, file_path, content, version, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.sessionId,
        artifact.stepId,
        artifact.iteration,
        artifact.type,
        artifact.filePath,
        artifact.content,
        artifact.version,
        artifact.metadata ? JSON.stringify(artifact.metadata) : null,
      );
    return result.lastInsertRowid as number;
  }

  getBySession(sessionId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToArtifact(r));
  }

  getByStep(sessionId: string, stepId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE session_id = ? AND step_id = ? ORDER BY version ASC')
      .all(sessionId, stepId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToArtifact(r));
  }

  getLatestByStep(sessionId: string, stepId: string): ArtifactRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM artifacts WHERE session_id = ? AND step_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(sessionId, stepId) as Record<string, unknown> | undefined;
    return row ? this.rowToArtifact(row) : null;
  }

  getByType(sessionId: string, type: ArtifactType): ArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE session_id = ? AND type = ? ORDER BY created_at ASC')
      .all(sessionId, type) as Record<string, unknown>[];
    return rows.map((r) => this.rowToArtifact(r));
  }

  private rowToArtifact(row: Record<string, unknown>): ArtifactRecord {
    return {
      id: row.id as number,
      sessionId: row.session_id as string,
      stepId: row.step_id as string,
      iteration: (row.iteration as number) ?? 1,
      type: row.type as ArtifactType,
      filePath: (row.file_path as string) ?? null,
      content: row.content as string,
      version: row.version as number,
      createdAt: row.created_at as string,
      metadata: row.metadata
        ? (JSON.parse(row.metadata as string) as Record<string, unknown>)
        : null,
    };
  }
}
