import { describe, expect, it, beforeEach } from 'vitest';
import { openDatabase } from '../../../src/memory/database.js';
import { JobStore } from '../../../src/memory/job-store.js';
import type Database from 'better-sqlite3';

describe('JobStore', () => {
  let db: Database.Database;
  let store: JobStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new JobStore(db);
  });

  describe('enqueue + get', () => {
    it('creates a queued job', () => {
      const id = store.enqueue({ type: 'review', payload: { file: 'test.ts' } });
      const job = store.get(id);
      expect(job).not.toBeNull();
      expect(job?.type).toBe('review');
      expect(job?.status).toBe('queued');
      expect(job?.priority).toBe(100);
      expect(JSON.parse(job?.payloadJson ?? '{}')).toEqual({ file: 'test.ts' });
    });

    it('accepts custom priority and session', () => {
      const id = store.enqueue({ type: 'cleanup', payload: {}, priority: 10, sessionId: 'sess_1' });
      const job = store.get(id);
      expect(job?.priority).toBe(10);
      expect(job?.sessionId).toBe('sess_1');
    });

    it('returns null for nonexistent ID', () => {
      expect(store.get('nope')).toBeNull();
    });
  });

  describe('claimNext', () => {
    it('claims queued jobs in priority order', () => {
      store.enqueue({ type: 'review', payload: { n: 1 }, priority: 200 });
      store.enqueue({ type: 'review', payload: { n: 2 }, priority: 50 });
      store.enqueue({ type: 'review', payload: { n: 3 }, priority: 100 });

      const claimed = store.claimNext('worker-1', 2);
      expect(claimed).toHaveLength(2);
      // Priority 50 first, then 100
      expect(JSON.parse(claimed[0].payloadJson).n).toBe(2);
      expect(JSON.parse(claimed[1].payloadJson).n).toBe(3);
      expect(claimed[0].status).toBe('running');
      expect(claimed[0].workerId).toBe('worker-1');
    });

    it('returns empty when no queued jobs', () => {
      const claimed = store.claimNext('worker-1');
      expect(claimed).toHaveLength(0);
    });

    it('does not claim already running jobs', () => {
      const id = store.enqueue({ type: 'review', payload: {} });
      store.claimNext('worker-1');
      const second = store.claimNext('worker-2');
      expect(second).toHaveLength(0);
    });
  });

  describe('succeed + fail', () => {
    it('marks job as succeeded with result', () => {
      const id = store.enqueue({ type: 'review', payload: {} });
      store.claimNext('w1');
      store.succeed(id, { score: 8 });
      const job = store.get(id);
      expect(job?.status).toBe('succeeded');
      expect(JSON.parse(job?.resultJson ?? '{}')).toEqual({ score: 8 });
      expect(job?.finishedAt).toBeGreaterThan(0);
    });

    it('marks job as failed with error', () => {
      const id = store.enqueue({ type: 'review', payload: {} });
      store.claimNext('w1');
      store.fail(id, 'timeout');
      const job = store.get(id);
      expect(job?.status).toBe('failed');
      expect(job?.errorText).toBe('timeout');
    });
  });

  describe('cancel', () => {
    it('cancels a queued job', () => {
      const id = store.enqueue({ type: 'review', payload: {} });
      store.cancel(id);
      expect(store.get(id)?.status).toBe('canceled');
    });

    it('does not cancel succeeded jobs', () => {
      const id = store.enqueue({ type: 'review', payload: {} });
      store.claimNext('w1');
      store.succeed(id, {});
      store.cancel(id);
      expect(store.get(id)?.status).toBe('succeeded');
    });
  });

  describe('retry', () => {
    it('retries a failed job', () => {
      const id = store.enqueue({ type: 'review', payload: {} });
      store.claimNext('w1');
      store.fail(id, 'error');
      const retried = store.retry(id);
      expect(retried).toBe(true);
      const job = store.get(id);
      expect(job?.status).toBe('queued');
      expect(job?.retryCount).toBe(1);
    });

    it('rejects retry when max retries exceeded', () => {
      const id = store.enqueue({ type: 'review', payload: {}, maxRetries: 0 });
      store.claimNext('w1');
      store.fail(id, 'error');
      expect(store.retry(id)).toBe(false);
    });

    it('rejects retry for running job', () => {
      const id = store.enqueue({ type: 'review', payload: {} });
      store.claimNext('w1');
      expect(store.retry(id)).toBe(false);
    });
  });

  describe('list', () => {
    it('lists all jobs', () => {
      store.enqueue({ type: 'review', payload: {} });
      store.enqueue({ type: 'cleanup', payload: {} });
      const list = store.list();
      expect(list).toHaveLength(2);
    });

    it('filters by status', () => {
      const id = store.enqueue({ type: 'review', payload: {} });
      store.enqueue({ type: 'review', payload: {} });
      store.claimNext('w1');
      const running = store.list({ status: 'running' });
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe(id);
    });

    it('filters by type', () => {
      store.enqueue({ type: 'review', payload: {} });
      store.enqueue({ type: 'cleanup', payload: {} });
      const reviews = store.list({ type: 'review' });
      expect(reviews).toHaveLength(1);
    });
  });

  describe('hasActive', () => {
    it('returns true for active dedupe key', () => {
      store.enqueue({ type: 'review', payload: {}, dedupeKey: 'review:src/foo.ts' });
      expect(store.hasActive('review:src/foo.ts')).toBe(true);
    });

    it('returns false after completion', () => {
      const id = store.enqueue({ type: 'review', payload: {}, dedupeKey: 'review:src/foo.ts' });
      store.claimNext('w1');
      store.succeed(id, {});
      expect(store.hasActive('review:src/foo.ts')).toBe(false);
    });
  });

  describe('logs', () => {
    it('appends and retrieves logs', () => {
      const id = store.enqueue({ type: 'review', payload: {} });
      store.appendLog(id, 'info', 'started', 'Job started');
      store.appendLog(id, 'info', 'progress', 'Scanning files...', { filesFound: 5 });
      store.appendLog(id, 'error', 'failed', 'Timeout');

      const logs = store.getLogs(id);
      expect(logs).toHaveLength(3);
      expect(logs[0].seq).toBe(1);
      expect(logs[0].eventType).toBe('started');
      expect(logs[2].level).toBe('error');
    });

    it('filters by fromSeq', () => {
      const id = store.enqueue({ type: 'review', payload: {} });
      store.appendLog(id, 'info', 'a');
      store.appendLog(id, 'info', 'b');
      store.appendLog(id, 'info', 'c');

      const logs = store.getLogs(id, 1);
      expect(logs).toHaveLength(2);
      expect(logs[0].eventType).toBe('b');
    });
  });
});
