// tests/unit/memory/build-store.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BuildStore, openDatabase } from '../../../src/memory/index.js';
import type Database from 'better-sqlite3';

describe('BuildStore', () => {
  let db: Database.Database;
  let store: BuildStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new BuildStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('create + get', () => {
    it('creates a build run with defaults', () => {
      store.create({ buildId: 'b1', task: 'add auth' });
      const run = store.get('b1');
      expect(run).not.toBeNull();
      expect(run!.buildId).toBe('b1');
      expect(run!.task).toBe('add auth');
      expect(run!.status).toBe('planning');
      expect(run!.currentPhase).toBe('debate');
      expect(run!.currentLoop).toBe(0);
      expect(run!.lastEventSeq).toBe(0);
      expect(run!.debateId).toBeNull();
      expect(run!.baselineRef).toBeNull();
    });

    it('creates with optional fields', () => {
      store.create({ buildId: 'b2', task: 'fix bug', debateId: 'd1', baselineRef: 'abc123' });
      const run = store.get('b2');
      expect(run!.debateId).toBe('d1');
      expect(run!.baselineRef).toBe('abc123');
    });

    it('returns null for nonexistent build', () => {
      expect(store.get('nonexistent')).toBeNull();
    });
  });

  describe('list', () => {
    it('lists all builds', () => {
      store.create({ buildId: 'b1', task: 'task 1' });
      store.create({ buildId: 'b2', task: 'task 2' });
      const list = store.list();
      expect(list).toHaveLength(2);
      const ids = list.map((b) => b.buildId).sort();
      expect(ids).toEqual(['b1', 'b2']);
    });

    it('filters by status', () => {
      store.create({ buildId: 'b1', task: 'task 1' });
      store.create({ buildId: 'b2', task: 'task 2' });
      store.updateWithEvent('b1', { status: 'completed', completedAt: Date.now() },
        { eventType: 'phase_transition', actor: 'system', phase: 'done' });
      const list = store.list({ status: 'completed' });
      expect(list).toHaveLength(1);
      expect(list[0].buildId).toBe('b1');
    });

    it('respects limit', () => {
      store.create({ buildId: 'b1', task: 't1' });
      store.create({ buildId: 'b2', task: 't2' });
      store.create({ buildId: 'b3', task: 't3' });
      const list = store.list({ limit: 2 });
      expect(list).toHaveLength(2);
    });
  });

  describe('updateWithEvent', () => {
    it('atomically updates run and appends event', () => {
      store.create({ buildId: 'b1', task: 'task' });
      store.updateWithEvent('b1',
        { status: 'implementing', currentPhase: 'plan_approved', planVersion: 1 },
        { eventType: 'plan_approved', actor: 'claude', phase: 'debate', payload: { plan: 'do stuff' } },
      );

      const run = store.get('b1');
      expect(run!.status).toBe('implementing');
      expect(run!.currentPhase).toBe('plan_approved');
      expect(run!.planVersion).toBe(1);
      expect(run!.lastEventSeq).toBe(1);

      const events = store.getEvents('b1');
      expect(events).toHaveLength(1);
      expect(events[0].seq).toBe(1);
      expect(events[0].eventType).toBe('plan_approved');
      expect(events[0].actor).toBe('claude');
      expect(events[0].payload).toEqual({ plan: 'do stuff' });
    });

    it('increments seq monotonically', () => {
      store.create({ buildId: 'b1', task: 'task' });
      store.updateWithEvent('b1', {},
        { eventType: 'debate_started', actor: 'system', phase: 'debate' });
      store.updateWithEvent('b1', {},
        { eventType: 'debate_converged', actor: 'system', phase: 'debate' });
      store.updateWithEvent('b1', {},
        { eventType: 'plan_approved', actor: 'claude', phase: 'debate' });

      const events = store.getEvents('b1');
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    });

    it('throws for nonexistent build', () => {
      expect(() =>
        store.updateWithEvent('nonexistent', {},
          { eventType: 'error', actor: 'system', phase: 'debate' }),
      ).toThrow('Build not found');
    });

    it('updates phase cursor', () => {
      store.create({ buildId: 'b1', task: 'task' });
      store.updateWithEvent('b1',
        { currentPhase: 'review', currentLoop: 2 },
        { eventType: 'review_requested', actor: 'codex', phase: 'review', loopIndex: 2 },
      );
      const run = store.get('b1');
      expect(run!.phaseCursor.phase).toBe('review');
      expect(run!.phaseCursor.loop).toBe(2);
      expect(run!.phaseCursor.actor).toBe('codex');
      expect(run!.phaseCursor.lastEventId).toBe(1);
    });
  });

  describe('getEvents', () => {
    it('returns events after a given seq', () => {
      store.create({ buildId: 'b1', task: 'task' });
      store.updateWithEvent('b1', {}, { eventType: 'debate_started', actor: 'system', phase: 'debate' });
      store.updateWithEvent('b1', {}, { eventType: 'debate_converged', actor: 'system', phase: 'debate' });
      store.updateWithEvent('b1', {}, { eventType: 'plan_approved', actor: 'claude', phase: 'debate' });

      const after1 = store.getEvents('b1', 1);
      expect(after1).toHaveLength(2);
      expect(after1[0].seq).toBe(2);
    });
  });

  describe('countEventsByType', () => {
    it('counts specific event types', () => {
      store.create({ buildId: 'b1', task: 'task' });
      store.updateWithEvent('b1', {}, { eventType: 'bug_found', actor: 'codex', phase: 'review' });
      store.updateWithEvent('b1', {}, { eventType: 'bug_found', actor: 'codex', phase: 'review' });
      store.updateWithEvent('b1', {}, { eventType: 'fix_completed', actor: 'claude', phase: 'fix' });

      expect(store.countEventsByType('b1', 'bug_found')).toBe(2);
      expect(store.countEventsByType('b1', 'fix_completed')).toBe(1);
      expect(store.countEventsByType('b1', 'error')).toBe(0);
    });
  });

  describe('codex session tracking', () => {
    it('stores separate plan and review sessions', () => {
      store.create({ buildId: 'b1', task: 'task' });
      store.updateWithEvent('b1',
        { planCodexSession: 'thread-plan-1' },
        { eventType: 'debate_started', actor: 'codex', phase: 'debate', codexThreadId: 'thread-plan-1' },
      );
      store.updateWithEvent('b1',
        { reviewCodexSession: 'thread-review-1' },
        { eventType: 'review_requested', actor: 'codex', phase: 'review', codexThreadId: 'thread-review-1' },
      );

      const run = store.get('b1');
      expect(run!.planCodexSession).toBe('thread-plan-1');
      expect(run!.reviewCodexSession).toBe('thread-review-1');
    });
  });
});
