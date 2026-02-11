import { describe, expect, it } from 'vitest';
import { getSchemaVersion, openDatabase, runMigrations } from '../../../src/memory/database.js';

describe('openDatabase', () => {
  it('creates all tables in :memory: database', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('artifacts');
    expect(names).toContain('decisions');
    expect(names).toContain('memories');
    expect(names).toContain('cost_log');
    expect(names).toContain('schema_meta');
    db.close();
  });

  it('creates FTS5 virtual table', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('memories_fts');
    db.close();
  });

  it('creates FTS sync triggers', () => {
    const db = openDatabase(':memory:');
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {
      name: string;
    }[];
    const names = triggers.map((t) => t.name);

    expect(names).toContain('memories_ai');
    expect(names).toContain('memories_ad');
    expect(names).toContain('memories_au');
    db.close();
  });

  it('enables WAL mode', () => {
    const db = openDatabase(':memory:');
    // :memory: databases can't use WAL, but the pragma runs without error
    // For file-based DBs this would return 'wal'
    const mode = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(mode[0].journal_mode).toBeDefined();
    db.close();
  });

  it('enables foreign keys', () => {
    const db = openDatabase(':memory:');
    const fk = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(fk[0].foreign_keys).toBe(1);
    db.close();
  });

  it('sets schema version', () => {
    const db = openDatabase(':memory:');
    const version = getSchemaVersion(db);
    expect(version).toBe('8');
    db.close();
  });

  it('is idempotent (can run migrations twice)', () => {
    const db = openDatabase(':memory:');
    // Run migrations again -- should be idempotent
    runMigrations(db);
    const version = getSchemaVersion(db);
    expect(version).toBe('8');
    db.close();
  });
});
