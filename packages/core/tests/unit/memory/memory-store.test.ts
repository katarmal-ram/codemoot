import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { MemoryStore } from '../../../src/memory/memory-store.js';

let db: Database.Database;
let store: MemoryStore;

beforeEach(() => {
  db = openDatabase(':memory:');
  store = new MemoryStore(db);
});

afterEach(() => {
  db.close();
});

describe('MemoryStore', () => {
  it('saves a memory and returns its ID', () => {
    const id = store.save({
      projectId: 'test-project',
      category: 'decision',
      content: 'Use JWT for authentication',
      sourceSessionId: null,
      importance: 0.9,
    });
    expect(id).toBeGreaterThan(0);
  });

  it('retrieves a memory by ID', () => {
    const id = store.save({
      projectId: 'test-project',
      category: 'convention',
      content: 'All API routes start with /api/v1',
      sourceSessionId: null,
      importance: 0.7,
    });
    const memory = store.getById(id);
    expect(memory).not.toBeNull();
    expect(memory?.content).toBe('All API routes start with /api/v1');
    expect(memory?.category).toBe('convention');
    expect(memory?.accessCount).toBe(0);
  });

  it('searches memories via FTS5', () => {
    store.save({
      projectId: 'p1',
      category: 'decision',
      content: 'Authentication uses JWT tokens with RS256',
      sourceSessionId: null,
      importance: 0.9,
    });
    store.save({
      projectId: 'p1',
      category: 'convention',
      content: 'Database migrations use Knex.js',
      sourceSessionId: null,
      importance: 0.5,
    });
    store.save({
      projectId: 'p2',
      category: 'decision',
      content: 'JWT signing key rotated monthly',
      sourceSessionId: null,
      importance: 0.8,
    });

    // Search for JWT in project p1
    const results = store.search('JWT', 'p1');
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('JWT');

    // Search for JWT across p2
    const results2 = store.search('JWT', 'p2');
    expect(results2).toHaveLength(1);
  });

  it('filters by category', () => {
    store.save({
      projectId: 'p1',
      category: 'decision',
      content: 'Use Postgres',
      sourceSessionId: null,
      importance: 0.8,
    });
    store.save({
      projectId: 'p1',
      category: 'convention',
      content: 'camelCase vars',
      sourceSessionId: null,
      importance: 0.6,
    });
    store.save({
      projectId: 'p1',
      category: 'decision',
      content: 'Use TypeScript',
      sourceSessionId: null,
      importance: 0.9,
    });

    const decisions = store.getByCategory('p1', 'decision');
    expect(decisions).toHaveLength(2);
    // Ordered by importance DESC
    expect(decisions[0].importance).toBeGreaterThanOrEqual(decisions[1].importance);

    const conventions = store.getByCategory('p1', 'convention');
    expect(conventions).toHaveLength(1);
  });

  it('records access and increments count', () => {
    const id = store.save({
      projectId: 'p1',
      category: 'pattern',
      content: 'Repository pattern for data access',
      sourceSessionId: null,
      importance: 0.7,
    });

    store.recordAccess(id);
    store.recordAccess(id);
    store.recordAccess(id);

    const memory = store.getById(id);
    expect(memory?.accessCount).toBe(3);
  });

  it('deletes a memory', () => {
    const id = store.save({
      projectId: 'p1',
      category: 'issue',
      content: 'Memory leak in websocket handler',
      sourceSessionId: null,
      importance: 0.6,
    });
    store.delete(id);
    expect(store.getById(id)).toBeNull();
  });

  it('FTS5 stays in sync after delete', () => {
    const id = store.save({
      projectId: 'p1',
      category: 'decision',
      content: 'Use Redis for caching',
      sourceSessionId: null,
      importance: 0.7,
    });
    store.delete(id);

    const results = store.search('Redis', 'p1');
    expect(results).toHaveLength(0);
  });

  it('handles empty search gracefully', () => {
    const results = store.search('nonexistent', 'p1');
    expect(results).toHaveLength(0);
  });
});
