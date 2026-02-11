import { describe, expect, it, beforeEach } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { MessageStore, parseDebateVerdict } from '../../../src/memory/message-store.js';
import type Database from 'better-sqlite3';

describe('MessageStore', () => {
  let db: Database.Database;
  let store: MessageStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new MessageStore(db);
  });

  const baseParams = {
    debateId: 'test-debate',
    round: 1,
    role: 'critic',
    bridge: 'codex',
    model: 'gpt-5.3-codex',
    promptText: 'Review this code for bugs',
  };

  describe('insertQueued', () => {
    it('inserts a message with queued status', () => {
      const id = store.insertQueued(baseParams);
      expect(id).toBeGreaterThan(0);

      const row = store.getByRound('test-debate', 1, 'critic');
      expect(row).not.toBeNull();
      expect(row?.status).toBe('queued');
      expect(row?.promptText).toContain('Review this code');
      expect(row?.bridge).toBe('codex');
    });

    it('rejects duplicate (debate_id, round, role)', () => {
      store.insertQueued(baseParams);
      expect(() => store.insertQueued(baseParams)).toThrow();
    });
  });

  describe('state machine transitions', () => {
    it('queued → running', () => {
      const id = store.insertQueued(baseParams);
      expect(store.markRunning(id)).toBe(true);

      const row = store.getByRound('test-debate', 1, 'critic');
      expect(row?.status).toBe('running');
    });

    it('running → completed', () => {
      const id = store.insertQueued(baseParams);
      store.markRunning(id);

      const ok = store.markCompleted(id, {
        responseText: 'Looks good. STANCE: SUPPORT',
        verdict: { stance: 'SUPPORT', confidence: 0.9, raw: null },
        usageJson: '{"inputTokens":100}',
        durationMs: 5000,
        sessionId: 'thread_abc',
      });
      expect(ok).toBe(true);

      const row = store.getByRound('test-debate', 1, 'critic');
      expect(row?.status).toBe('completed');
      expect(row?.stance).toBe('SUPPORT');
      expect(row?.confidence).toBe(0.9);
      expect(row?.sessionId).toBe('thread_abc');
      expect(row?.completedAt).toBeGreaterThan(0);
    });

    it('running → failed', () => {
      const id = store.insertQueued(baseParams);
      store.markRunning(id);

      expect(store.markFailed(id, 'timeout')).toBe(true);

      const row = store.getByRound('test-debate', 1, 'critic');
      expect(row?.status).toBe('failed');
      expect(row?.error).toBe('timeout');
    });

    it('failed → running (retry)', () => {
      const id = store.insertQueued(baseParams);
      store.markRunning(id);
      store.markFailed(id, 'timeout');

      // Retry: failed → running
      expect(store.markRunning(id)).toBe(true);
      const row = store.getByRound('test-debate', 1, 'critic');
      expect(row?.status).toBe('running');
    });

    it('rejects invalid transitions', () => {
      const id = store.insertQueued(baseParams);
      // queued → completed (invalid, must go through running)
      const ok = store.markCompleted(id, {
        responseText: 'test',
        verdict: { stance: null, confidence: null, raw: null },
        usageJson: '{}',
        durationMs: 0,
        sessionId: null,
      });
      expect(ok).toBe(false);
    });

    it('rejects markRunning on completed row', () => {
      const id = store.insertQueued(baseParams);
      store.markRunning(id);
      store.markCompleted(id, {
        responseText: 'done',
        verdict: { stance: 'SUPPORT', confidence: null, raw: null },
        usageJson: '{}',
        durationMs: 100,
        sessionId: null,
      });

      // completed → running (invalid)
      expect(store.markRunning(id)).toBe(false);
    });
  });

  describe('getHistory', () => {
    it('returns messages ordered by round', () => {
      store.insertQueued({ ...baseParams, round: 1 });
      store.insertQueued({ ...baseParams, round: 2 });
      store.insertQueued({ ...baseParams, round: 3 });

      const history = store.getHistory('test-debate');
      expect(history).toHaveLength(3);
      expect(history[0].round).toBe(1);
      expect(history[2].round).toBe(3);
    });
  });

  describe('idempotency', () => {
    it('returns cached response for completed row', () => {
      const id = store.insertQueued(baseParams);
      store.markRunning(id);
      store.markCompleted(id, {
        responseText: 'cached response',
        verdict: { stance: 'SUPPORT', confidence: null, raw: null },
        usageJson: '{}',
        durationMs: 100,
        sessionId: 'thread_123',
      });

      const existing = store.getByRound('test-debate', 1, 'critic');
      expect(existing?.status).toBe('completed');
      expect(existing?.responseText).toBe('cached response');
    });
  });

  describe('recoverStale', () => {
    it('marks stale running rows as failed', () => {
      const id = store.insertQueued(baseParams);
      store.markRunning(id);

      // Force updated_at to be old
      db.prepare('UPDATE debate_messages SET updated_at = ? WHERE id = ?')
        .run(Date.now() - 600_000, id);

      const count = store.recoverStale(300_000); // 5 min threshold
      expect(count).toBe(1);

      const row = store.getByRound('test-debate', 1, 'critic');
      expect(row?.status).toBe('failed');
      expect(row?.error).toBe('STALE_RECOVERY');
    });

    it('does not affect recent running rows', () => {
      const id = store.insertQueued(baseParams);
      store.markRunning(id);

      const count = store.recoverStale(300_000);
      expect(count).toBe(0);
    });
  });

  describe('CHECK constraints', () => {
    it('rejects negative round', () => {
      expect(() => store.insertQueued({ ...baseParams, round: -1 })).toThrow();
    });
  });
});

describe('parseDebateVerdict', () => {
  it('parses structured JSON block', () => {
    const text = `Some analysis here.
---VERDICT---
{"stance": "SUPPORT", "confidence": 0.85}
---END_VERDICT---`;
    const v = parseDebateVerdict(text);
    expect(v.stance).toBe('SUPPORT');
    expect(v.confidence).toBe(0.85);
    expect(v.raw).toContain('VERDICT');
  });

  it('falls back to STANCE regex', () => {
    const text = 'I agree with this proposal.\n\nSTANCE: OPPOSE';
    const v = parseDebateVerdict(text);
    expect(v.stance).toBe('OPPOSE');
    expect(v.confidence).toBeNull();
    expect(v.raw).toBeNull();
  });

  it('returns nulls when no verdict found', () => {
    const v = parseDebateVerdict('Just some random text');
    expect(v.stance).toBeNull();
    expect(v.confidence).toBeNull();
  });

  it('handles malformed JSON in verdict block', () => {
    const text = '---VERDICT---\n{bad json}\n---END_VERDICT---\nSTANCE: UNCERTAIN';
    const v = parseDebateVerdict(text);
    expect(v.stance).toBe('UNCERTAIN');
  });

  it('handles case-insensitive stance', () => {
    const text = 'stance: support';
    const v = parseDebateVerdict(text);
    expect(v.stance).toBe('SUPPORT');
  });

  it('parses leading stance word without STANCE: prefix', () => {
    const text = 'SUPPORT — I agree with this proposal for several reasons.';
    const v = parseDebateVerdict(text);
    expect(v.stance).toBe('SUPPORT');
  });

  it('parses OPPOSE at start of line', () => {
    const text = 'Some preamble.\nOPPOSE. The design has fundamental issues.';
    const v = parseDebateVerdict(text);
    expect(v.stance).toBe('OPPOSE');
  });
});
