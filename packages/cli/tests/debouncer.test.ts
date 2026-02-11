import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Debouncer, type FlushBatch } from '../src/watch/debouncer.js';

describe('Debouncer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('flushes after quiet period', () => {
    const batches: FlushBatch[] = [];
    const d = new Debouncer((b) => batches.push(b), { quietMs: 100, maxWaitMs: 5000, cooldownMs: 0, maxBatchSize: 50 });

    d.push({ path: 'a.ts', event: 'change', ts: Date.now() });
    expect(batches).toHaveLength(0);

    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(1);
    expect(batches[0].files).toEqual(['a.ts']);
    expect(batches[0].reason).toBe('quiet');
    d.destroy();
  });

  it('resets quiet timer on new event', () => {
    const batches: FlushBatch[] = [];
    const d = new Debouncer((b) => batches.push(b), { quietMs: 100, maxWaitMs: 5000, cooldownMs: 0, maxBatchSize: 50 });

    d.push({ path: 'a.ts', event: 'change', ts: Date.now() });
    vi.advanceTimersByTime(80);
    d.push({ path: 'b.ts', event: 'change', ts: Date.now() });
    vi.advanceTimersByTime(80);
    expect(batches).toHaveLength(0);

    vi.advanceTimersByTime(20);
    expect(batches).toHaveLength(1);
    expect(batches[0].files).toEqual(['a.ts', 'b.ts']);
    d.destroy();
  });

  it('force flushes at maxWait', () => {
    const batches: FlushBatch[] = [];
    const d = new Debouncer((b) => batches.push(b), { quietMs: 200, maxWaitMs: 500, cooldownMs: 0, maxBatchSize: 50 });

    // Keep pushing events every 100ms to prevent quiet flush
    for (let i = 0; i < 10; i++) {
      d.push({ path: `f${i}.ts`, event: 'change', ts: Date.now() });
      vi.advanceTimersByTime(100);
    }

    // maxWait (500ms) should have triggered by now
    expect(batches.length).toBeGreaterThanOrEqual(1);
    expect(batches[0].reason).toBe('maxWait');
    d.destroy();
  });

  it('flushes at maxBatchSize', () => {
    const batches: FlushBatch[] = [];
    const d = new Debouncer((b) => batches.push(b), { quietMs: 1000, maxWaitMs: 5000, cooldownMs: 0, maxBatchSize: 3 });

    d.push({ path: 'a.ts', event: 'change', ts: Date.now() });
    d.push({ path: 'b.ts', event: 'change', ts: Date.now() });
    expect(batches).toHaveLength(0);

    d.push({ path: 'c.ts', event: 'change', ts: Date.now() });
    expect(batches).toHaveLength(1);
    expect(batches[0].files).toHaveLength(3);
    expect(batches[0].reason).toBe('maxBatch');
    d.destroy();
  });

  it('respects cooldown period', () => {
    const batches: FlushBatch[] = [];
    const now = Date.now();
    const d = new Debouncer((b) => batches.push(b), { quietMs: 50, maxWaitMs: 5000, cooldownMs: 200, maxBatchSize: 50 });

    d.push({ path: 'a.ts', event: 'change', ts: now });
    vi.advanceTimersByTime(50);
    expect(batches).toHaveLength(1);

    // During cooldown, events are rejected
    const accepted = d.push({ path: 'b.ts', event: 'change', ts: now + 51 });
    expect(accepted).toBe(false);
    d.destroy();
  });

  it('deduplicates same file in batch', () => {
    const batches: FlushBatch[] = [];
    const d = new Debouncer((b) => batches.push(b), { quietMs: 100, maxWaitMs: 5000, cooldownMs: 0, maxBatchSize: 50 });

    d.push({ path: 'a.ts', event: 'change', ts: Date.now() });
    d.push({ path: 'a.ts', event: 'change', ts: Date.now() });
    d.push({ path: 'a.ts', event: 'change', ts: Date.now() });

    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(1);
    expect(batches[0].files).toEqual(['a.ts']);
    d.destroy();
  });

  it('cancel clears pending', () => {
    const batches: FlushBatch[] = [];
    const d = new Debouncer((b) => batches.push(b), { quietMs: 100, maxWaitMs: 5000, cooldownMs: 0, maxBatchSize: 50 });

    d.push({ path: 'a.ts', event: 'change', ts: Date.now() });
    expect(d.getPendingCount()).toBe(1);

    d.cancel();
    expect(d.getPendingCount()).toBe(0);

    vi.advanceTimersByTime(200);
    expect(batches).toHaveLength(0);
    d.destroy();
  });

  it('flushNow triggers manual flush', () => {
    const batches: FlushBatch[] = [];
    const d = new Debouncer((b) => batches.push(b), { quietMs: 5000, maxWaitMs: 50000, cooldownMs: 0, maxBatchSize: 50 });

    d.push({ path: 'a.ts', event: 'change', ts: Date.now() });
    d.flushNow();

    expect(batches).toHaveLength(1);
    expect(batches[0].reason).toBe('manual');
    d.destroy();
  });

  it('destroyed debouncer rejects pushes', () => {
    const batches: FlushBatch[] = [];
    const d = new Debouncer((b) => batches.push(b));
    d.destroy();

    const accepted = d.push({ path: 'a.ts', event: 'change', ts: Date.now() });
    expect(accepted).toBe(false);
  });
});
