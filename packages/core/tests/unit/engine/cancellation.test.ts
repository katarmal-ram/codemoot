import { describe, expect, it, vi } from 'vitest';
import { CancellationError, CancellationToken } from '../../../src/engine/cancellation.js';

describe('CancellationToken', () => {
  it('starts as not cancelled', () => {
    const token = new CancellationToken();
    expect(token.isCancelled).toBe(false);
  });

  it('becomes cancelled after cancel()', () => {
    const token = new CancellationToken();
    token.cancel();
    expect(token.isCancelled).toBe(true);
  });

  it('cancel() is idempotent — double cancel is safe', () => {
    const token = new CancellationToken();
    const callback = vi.fn();
    token.onCancel(callback);
    token.cancel();
    token.cancel();
    // Callback only fires once
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('throwIfCancelled does nothing when not cancelled', () => {
    const token = new CancellationToken();
    expect(() => token.throwIfCancelled()).not.toThrow();
  });

  it('throwIfCancelled throws CancellationError when cancelled', () => {
    const token = new CancellationToken();
    token.cancel();
    expect(() => token.throwIfCancelled()).toThrow(CancellationError);
    expect(() => token.throwIfCancelled()).toThrow('Operation was cancelled');
  });

  it('onCancel fires callback on cancel', () => {
    const token = new CancellationToken();
    const callback = vi.fn();
    token.onCancel(callback);
    token.cancel();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('onCancel fires immediately if already cancelled', () => {
    const token = new CancellationToken();
    token.cancel();
    const callback = vi.fn();
    token.onCancel(callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('onCancel deduplicates same callback reference', () => {
    const token = new CancellationToken();
    const callback = vi.fn();
    token.onCancel(callback);
    token.onCancel(callback); // Same reference
    token.cancel();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('onCancel supports multiple different callbacks', () => {
    const token = new CancellationToken();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    token.onCancel(cb1);
    token.onCancel(cb2);
    token.cancel();
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('offCancel removes callback so it does not fire', () => {
    const token = new CancellationToken();
    const callback = vi.fn();
    token.onCancel(callback);
    token.offCancel(callback);
    token.cancel();
    expect(callback).not.toHaveBeenCalled();
  });

  it('swallows callback errors during cancel', () => {
    const token = new CancellationToken();
    token.onCancel(() => {
      throw new Error('callback error');
    });
    // Should not throw
    expect(() => token.cancel()).not.toThrow();
    expect(token.isCancelled).toBe(true);
  });
});

describe('CancellationToken.sleep()', () => {
  it('resolves true after sleep completes', async () => {
    const token = new CancellationToken();
    const result = await token.sleep(10);
    expect(result).toBe(true);
  });

  it('resolves false immediately if already cancelled', async () => {
    const token = new CancellationToken();
    token.cancel();
    const start = Date.now();
    const result = await token.sleep(10_000);
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });

  it('resolves false when cancelled during sleep', async () => {
    const token = new CancellationToken();
    const promise = token.sleep(10_000);
    // Cancel after a short delay
    setTimeout(() => token.cancel(), 20);
    const start = Date.now();
    const result = await promise;
    const elapsed = Date.now() - start;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe('CancellationError', () => {
  it('has correct name', () => {
    const err = new CancellationError('test');
    expect(err.name).toBe('CancellationError');
    expect(err.message).toBe('test');
    expect(err).toBeInstanceOf(Error);
  });
});
