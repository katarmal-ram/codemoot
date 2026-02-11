import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { DebateStore } from '../../../src/memory/debate-store.js';
import type { DebateEngineState } from '../../../src/types/debate.js';

function createStore() {
  const db = openDatabase(':memory:');
  return { db, store: new DebateStore(db) };
}

describe('DebateStore', () => {
  it('upserts and retrieves a debate turn', () => {
    const { db, store } = createStore();
    store.upsert({ debateId: 'd1', role: 'critic' });

    const row = store.get('d1', 'critic');
    expect(row).not.toBeNull();
    expect(row?.debateId).toBe('d1');
    expect(row?.role).toBe('critic');
    expect(row?.status).toBe('active');
    expect(row?.codexSessionId).toBeNull();
    db.close();
  });

  it('upserts updates existing row on conflict', () => {
    const { db, store } = createStore();
    store.upsert({ debateId: 'd1', role: 'critic', round: 1 });
    store.upsert({ debateId: 'd1', role: 'critic', round: 2, codexSessionId: 'sess-1' });

    const row = store.get('d1', 'critic');
    expect(row?.round).toBe(2);
    expect(row?.codexSessionId).toBe('sess-1');
    db.close();
  });

  it('getByDebateId returns all turns for a debate', () => {
    const { db, store } = createStore();
    store.upsert({ debateId: 'd1', role: 'proposer' });
    store.upsert({ debateId: 'd1', role: 'critic' });
    store.upsert({ debateId: 'd2', role: 'proposer' });

    const turns = store.getByDebateId('d1');
    expect(turns).toHaveLength(2);
    db.close();
  });

  it('updateSessionId persists codex thread_id', () => {
    const { db, store } = createStore();
    store.upsert({ debateId: 'd1', role: 'critic' });
    store.updateSessionId('d1', 'critic', 'thread-abc');

    const row = store.get('d1', 'critic');
    expect(row?.codexSessionId).toBe('thread-abc');
    db.close();
  });

  it('updateStatus changes status', () => {
    const { db, store } = createStore();
    store.upsert({ debateId: 'd1', role: 'critic' });
    store.updateStatus('d1', 'critic', 'completed');

    const row = store.get('d1', 'critic');
    expect(row?.status).toBe('completed');
    db.close();
  });

  it('incrementResumeFailCount increments counter', () => {
    const { db, store } = createStore();
    store.upsert({ debateId: 'd1', role: 'critic' });
    store.incrementResumeFailCount('d1', 'critic');
    store.incrementResumeFailCount('d1', 'critic');

    const row = store.get('d1', 'critic');
    expect(row?.resumeFailCount).toBe(2);
    db.close();
  });

  it('saveState and loadState round-trip debate state', () => {
    const { db, store } = createStore();
    store.upsert({ debateId: 'd1', role: 'proposer' });

    const state: DebateEngineState = {
      debateId: 'd1',
      question: 'test question',
      models: ['claude', 'codex'],
      round: 2,
      turn: 4,
      thread: [],
      runningSummary: 'summary here',
      stanceHistory: [],
      usage: { totalPromptTokens: 100, totalCompletionTokens: 50, totalCalls: 4, startedAt: Date.now() },
      status: 'running',
      sessionIds: { codex: 'thread-xyz' },
      resumeStats: { attempted: 2, succeeded: 1, fallbacks: 1 },
    };

    store.saveState('d1', 'proposer', state);
    const loaded = store.loadState('d1', 'proposer');

    expect(loaded).not.toBeNull();
    expect(loaded?.debateId).toBe('d1');
    expect(loaded?.question).toBe('test question');
    expect(loaded?.round).toBe(2);
    expect(loaded?.sessionIds.codex).toBe('thread-xyz');
    expect(loaded?.resumeStats.fallbacks).toBe(1);
    db.close();
  });

  it('loadState returns null for missing state', () => {
    const { db, store } = createStore();
    store.upsert({ debateId: 'd1', role: 'proposer' });
    const loaded = store.loadState('d1', 'proposer');
    expect(loaded).toBeNull();
    db.close();
  });

  it('list returns debates filtered by status', () => {
    const { db, store } = createStore();
    store.upsert({ debateId: 'd1', role: 'critic', status: 'active' });
    store.upsert({ debateId: 'd2', role: 'critic', status: 'completed' });

    const active = store.list({ status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0].debateId).toBe('d1');

    const all = store.list();
    expect(all).toHaveLength(2);
    db.close();
  });

  it('markStale marks old active debates as stale', () => {
    const { db, store } = createStore();
    store.upsert({ debateId: 'd1', role: 'critic' });

    // Manually set last_activity to 2 hours ago
    db.prepare(
      'UPDATE debate_turns SET last_activity_at = ? WHERE debate_id = ?',
    ).run(Date.now() - 2 * 60 * 60 * 1000, 'd1');

    const count = store.markStale(60 * 60 * 1000); // 1 hour threshold
    expect(count).toBe(1);

    const row = store.get('d1', 'critic');
    expect(row?.status).toBe('stale');
    db.close();
  });

  it('markExpired marks old stale debates as expired', () => {
    const { db, store } = createStore();
    store.upsert({ debateId: 'd1', role: 'critic', status: 'stale' });

    // Set to 31 days ago
    db.prepare(
      'UPDATE debate_turns SET last_activity_at = ?, status = ? WHERE debate_id = ?',
    ).run(Date.now() - 31 * 24 * 60 * 60 * 1000, 'stale', 'd1');

    const count = store.markExpired(30 * 24 * 60 * 60 * 1000); // 30 day threshold
    expect(count).toBe(1);

    const row = store.get('d1', 'critic');
    expect(row?.status).toBe('expired');
    db.close();
  });
});
