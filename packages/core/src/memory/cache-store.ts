// packages/core/src/memory/cache-store.ts — Result caching with content+config hash

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface CacheEntry {
  id: number;
  key: string;
  kind: string;
  contentHash: string;
  configHash: string;
  model: string;
  valueJson: string;
  expiresAt: number;
  hitCount: number;
  createdAt: number;
}

export class CacheStore {
  constructor(private db: Database.Database) {}

  get(key: string, contentHash: string, configHash: string): CacheEntry | null {
    const row = this.db
      .prepare(
        'SELECT id, key, kind, content_hash, config_hash, model, value_json, expires_at, hit_count, created_at FROM cache_entries WHERE key = ? AND content_hash = ? AND config_hash = ? AND expires_at > ?',
      )
      .get(key, contentHash, configHash, Date.now()) as Record<string, unknown> | undefined;

    if (row) {
      this.db
        .prepare('UPDATE cache_entries SET hit_count = hit_count + 1 WHERE id = ?')
        .run(row.id);
      return {
        id: row.id as number,
        key: row.key as string,
        kind: row.kind as string,
        contentHash: row.content_hash as string,
        configHash: row.config_hash as string,
        model: row.model as string,
        valueJson: row.value_json as string,
        expiresAt: row.expires_at as number,
        hitCount: row.hit_count as number,
        createdAt: row.created_at as number,
      };
    }
    return null;
  }

  set(entry: {
    key: string;
    kind: string;
    contentHash: string;
    configHash: string;
    model: string;
    valueJson: string;
    ttlMs: number;
  }): void {
    // Upsert: delete old entries for same key first
    this.db.prepare('DELETE FROM cache_entries WHERE key = ?').run(entry.key);
    this.db
      .prepare(
        'INSERT INTO cache_entries (key, kind, content_hash, config_hash, model, value_json, expires_at, hit_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
      )
      .run(
        entry.key,
        entry.kind,
        entry.contentHash,
        entry.configHash,
        entry.model,
        entry.valueJson,
        Date.now() + entry.ttlMs,
        Date.now(),
      );
  }

  evictExpired(): number {
    const result = this.db
      .prepare('DELETE FROM cache_entries WHERE expires_at <= ?')
      .run(Date.now());
    return result.changes;
  }

  clear(): number {
    const result = this.db.prepare('DELETE FROM cache_entries').run();
    return result.changes;
  }

  stats(): { totalEntries: number; totalHits: number; expiredCount: number } {
    const total = this.db.prepare('SELECT COUNT(*) as cnt FROM cache_entries').get() as {
      cnt: number;
    };
    const hits = this.db
      .prepare('SELECT COALESCE(SUM(hit_count), 0) as total FROM cache_entries')
      .get() as { total: number };
    const expired = this.db
      .prepare('SELECT COUNT(*) as cnt FROM cache_entries WHERE expires_at <= ?')
      .get(Date.now()) as { cnt: number };
    return { totalEntries: total.cnt, totalHits: hits.total, expiredCount: expired.cnt };
  }
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function hashConfig(config: Record<string, unknown>): string {
  const sorted = JSON.stringify(config, Object.keys(config).sort());
  return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}
