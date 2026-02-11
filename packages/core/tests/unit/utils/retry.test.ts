import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../../../src/utils/retry.js';

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');

    const result = await withRetry(fn, { attempts: 3, backoff: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after all attempts exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    await expect(withRetry(fn, { attempts: 3, backoff: 1 })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry when retryOn returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('no retry'));

    await expect(
      withRetry(fn, {
        attempts: 3,
        backoff: 1,
        retryOn: () => false,
      }),
    ).rejects.toThrow('no retry');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries only when retryOn returns true', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, {
      attempts: 3,
      backoff: 1,
      retryOn: (err) => err instanceof Error && err.message === 'rate limit',
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('uses exponential backoff', async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { attempts: 3, backoff: 100 });

    // First retry: 100ms * 2^0 = 100ms
    await vi.advanceTimersByTimeAsync(100);
    // Second retry: 100ms * 2^1 = 200ms
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it('defaults to 3 attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(withRetry(fn, { backoff: 1 })).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
