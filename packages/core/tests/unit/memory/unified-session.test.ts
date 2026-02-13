import { describe, expect, it, beforeEach } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { SessionManager } from '../../../src/memory/unified-session.js';
import type Database from 'better-sqlite3';

describe('SessionManager', () => {
  let db: Database.Database;
  let mgr: SessionManager;

  beforeEach(() => {
    db = openDatabase(':memory:');
    mgr = new SessionManager(db);
  });

  describe('create + get', () => {
    it('creates a session with active status', () => {
      const id = mgr.create('test-session');
      const session = mgr.get(id);
      expect(session).not.toBeNull();
      expect(session?.name).toBe('test-session');
      expect(session?.status).toBe('active');
      expect(session?.codexThreadId).toBeNull();
      expect(session?.tokenUsage).toBe(0);
    });

    it('creates without a name', () => {
      const id = mgr.create();
      const session = mgr.get(id);
      expect(session?.name).toBeNull();
    });

    it('returns null for nonexistent ID', () => {
      expect(mgr.get('nonexistent')).toBeNull();
    });
  });

  describe('getActive + resolveActive', () => {
    it('returns null when no active sessions', () => {
      expect(mgr.getActive()).toBeNull();
    });

    it('returns the most recently updated active session', () => {
      const id1 = mgr.create('first');
      const id2 = mgr.create('second');
      // Force id2 to have a later updated_at
      db.prepare('UPDATE codemoot_sessions SET updated_at = updated_at + 1000 WHERE id = ?').run(id2);
      const active = mgr.getActive();
      expect(active?.id).toBe(id2);
    });

    it('resolveActive creates when none exists', () => {
      const session = mgr.resolveActive('auto');
      expect(session.status).toBe('active');
      expect(session.name).toBe('auto');
    });

    it('resolveActive returns existing', () => {
      const id = mgr.create('existing');
      const resolved = mgr.resolveActive('should-not-create');
      expect(resolved.id).toBe(id);
    });
  });

  describe('thread management', () => {
    it('updates codex thread ID', () => {
      const id = mgr.create();
      mgr.updateThreadId(id, 'thread_abc');
      const session = mgr.get(id);
      expect(session?.codexThreadId).toBe('thread_abc');
    });

    it('clears thread ID when null is passed', () => {
      const id = mgr.create();
      mgr.updateThreadId(id, 'thread_abc');
      mgr.updateThreadId(id, null);
      const session = mgr.get(id);
      expect(session?.codexThreadId).toBeNull();
    });
  });

  describe('token tracking', () => {
    it('accumulates token usage', () => {
      const id = mgr.create();
      mgr.addTokenUsage(id, 1000);
      mgr.addTokenUsage(id, 2000);
      const session = mgr.get(id);
      expect(session?.tokenUsage).toBe(3000);
    });

    it('addUsageFromResult uses real totalTokens when available', () => {
      const id = mgr.create();
      mgr.addUsageFromResult(id, { totalTokens: 5000, inputTokens: 3000, outputTokens: 2000 });
      const session = mgr.get(id);
      expect(session?.tokenUsage).toBe(5000);
    });

    it('addUsageFromResult sums input+output when totalTokens is 0', () => {
      const id = mgr.create();
      mgr.addUsageFromResult(id, { totalTokens: 0, inputTokens: 3000, outputTokens: 2000 });
      const session = mgr.get(id);
      expect(session?.tokenUsage).toBe(5000);
    });

    it('addUsageFromResult falls back to estimate when no usage', () => {
      const id = mgr.create();
      mgr.addUsageFromResult(id, {}, 'hello world', 'response here');
      const session = mgr.get(id);
      // char/4 estimate: (11 + 13) / 4 ≈ 6 tokens
      expect(session?.tokenUsage).toBeGreaterThan(0);
    });

    it('addUsageFromResult does nothing when no usage and no text', () => {
      const id = mgr.create();
      mgr.addUsageFromResult(id, {});
      const session = mgr.get(id);
      expect(session?.tokenUsage).toBe(0);
    });
  });

  describe('maxContext default', () => {
    it('defaults to 400K for new sessions', () => {
      const id = mgr.create();
      const session = mgr.get(id);
      expect(session?.maxContext).toBe(400_000);
    });
  });

  describe('complete', () => {
    it('marks session as completed', () => {
      const id = mgr.create();
      mgr.complete(id);
      const session = mgr.get(id);
      expect(session?.status).toBe('completed');
      expect(session?.completedAt).toBeGreaterThan(0);
    });

    it('completed sessions are not returned by getActive', () => {
      const id = mgr.create();
      mgr.complete(id);
      expect(mgr.getActive()).toBeNull();
    });
  });

  describe('list', () => {
    it('lists all sessions', () => {
      mgr.create('a');
      mgr.create('b');
      mgr.create('c');
      const list = mgr.list();
      expect(list).toHaveLength(3);
      const names = list.map(s => s.name).sort();
      expect(names).toEqual(['a', 'b', 'c']);
    });

    it('filters by status', () => {
      const id1 = mgr.create('active-one');
      const id2 = mgr.create('done');
      mgr.complete(id2);
      const list = mgr.list({ status: 'active' });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(id1);
    });
  });

  describe('events', () => {
    it('records and retrieves events', () => {
      const sessionId = mgr.create();
      mgr.recordEvent({
        sessionId,
        command: 'review',
        promptPreview: 'Review this file...',
        responsePreview: 'Found 3 bugs...',
        usageJson: '{"inputTokens":1000}',
        durationMs: 5000,
        codexThreadId: 'thread_xyz',
      });
      mgr.recordEvent({
        sessionId,
        command: 'debate',
        subcommand: 'turn',
        promptPreview: 'What about...',
      });

      const events = mgr.getEvents(sessionId);
      expect(events).toHaveLength(2);
      // Both events exist, check by finding them (ordering may be same-ms)
      const commands = events.map(e => e.command).sort();
      expect(commands).toEqual(['debate', 'review']);
      const reviewEvent = events.find(e => e.command === 'review');
      expect(reviewEvent?.codexThreadId).toBe('thread_xyz');
    });
  });

  describe('schema v5', () => {
    it('codemoot_session_id column exists on debate_messages', () => {
      // Should not throw — column exists
      db.prepare('SELECT codemoot_session_id FROM debate_messages LIMIT 0').all();
    });

    it('codemoot_session_id column exists on build_events', () => {
      db.prepare('SELECT codemoot_session_id FROM build_events LIMIT 0').all();
    });
  });
});
