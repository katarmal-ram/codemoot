import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { CacheStore, hashContent, hashConfig } from '../../../src/memory/cache-store.js';

function createStore() {
  const db = openDatabase(':memory:');
  return { db, store: new CacheStore(db) };
}

describe('CacheStore', () => {
  it('set and get', () => {
    const { db, store } = createStore();
    store.set({ key: 'k1', kind: 'review', contentHash: 'abc', configHash: 'def', model: 'gpt', valueJson: '{"x":1}', ttlMs: 60000 });
    const entry = store.get('k1', 'abc', 'def');
    expect(entry).not.toBeNull();
    expect(entry?.valueJson).toBe('{"x":1}');
    db.close();
  });

  it('returns null for mismatched content hash', () => {
    const { db, store } = createStore();
    store.set({ key: 'k1', kind: 'review', contentHash: 'abc', configHash: 'def', model: 'gpt', valueJson: '{}', ttlMs: 60000 });
    expect(store.get('k1', 'DIFFERENT', 'def')).toBeNull();
    db.close();
  });

  it('returns null for expired entries', () => {
    const { db, store } = createStore();
    store.set({ key: 'k1', kind: 'review', contentHash: 'abc', configHash: 'def', model: 'gpt', valueJson: '{}', ttlMs: -1 });
    expect(store.get('k1', 'abc', 'def')).toBeNull();
    db.close();
  });

  it('increments hit count', () => {
    const { db, store } = createStore();
    store.set({ key: 'k1', kind: 'review', contentHash: 'abc', configHash: 'def', model: 'gpt', valueJson: '{}', ttlMs: 60000 });
    store.get('k1', 'abc', 'def');
    store.get('k1', 'abc', 'def');
    const entry = store.get('k1', 'abc', 'def');
    // SELECT reads before UPDATE bumps: 3rd call reads hit_count=2
    expect(entry?.hitCount).toBe(2);
    db.close();
  });

  it('evictExpired removes old entries', () => {
    const { db, store } = createStore();
    store.set({ key: 'k1', kind: 'review', contentHash: 'a', configHash: 'b', model: 'g', valueJson: '{}', ttlMs: -1 });
    store.set({ key: 'k2', kind: 'review', contentHash: 'c', configHash: 'd', model: 'g', valueJson: '{}', ttlMs: 60000 });
    const evicted = store.evictExpired();
    expect(evicted).toBe(1);
    db.close();
  });

  it('clear removes all entries', () => {
    const { db, store } = createStore();
    store.set({ key: 'k1', kind: 'r', contentHash: 'a', configHash: 'b', model: 'g', valueJson: '{}', ttlMs: 60000 });
    store.set({ key: 'k2', kind: 'r', contentHash: 'c', configHash: 'd', model: 'g', valueJson: '{}', ttlMs: 60000 });
    expect(store.clear()).toBe(2);
    db.close();
  });

  it('stats returns counts', () => {
    const { db, store } = createStore();
    store.set({ key: 'k1', kind: 'r', contentHash: 'a', configHash: 'b', model: 'g', valueJson: '{}', ttlMs: 60000 });
    store.get('k1', 'a', 'b');
    const s = store.stats();
    expect(s.totalEntries).toBe(1);
    expect(s.totalHits).toBe(1);
    db.close();
  });
});

describe('hashContent', () => {
  it('returns 16-char hex string', () => {
    const h = hashContent('hello world');
    expect(h).toHaveLength(16);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it('same input produces same hash', () => {
    expect(hashContent('test')).toBe(hashContent('test'));
  });
});

describe('hashConfig', () => {
  it('order-independent', () => {
    expect(hashConfig({ a: 1, b: 2 })).toBe(hashConfig({ b: 2, a: 1 }));
  });
});
