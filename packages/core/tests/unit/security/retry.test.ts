import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateBackoff,
  isRateLimit,
  isRetryable,
  parseRetryAfter,
  withCanonicalRetry,
} from '../../../src/security/retry.js';

describe('isRetryable', () => {
  it('returns true for 500 status', () => {
    const error = { status: 500, message: 'Internal Server Error' };
    expect(isRetryable(error)).toBe(true);
  });

  it('returns true for 503 status', () => {
    const error = { status: 503, message: 'Service Unavailable' };
    expect(isRetryable(error)).toBe(true);
  });

  it('returns true for ETIMEDOUT error', () => {
    const error = new Error('connect ETIMEDOUT 1.2.3.4:443');
    expect(isRetryable(error)).toBe(true);
  });

  it('returns true for ECONNRESET error', () => {
    const error = new Error('read ECONNRESET');
    expect(isRetryable(error)).toBe(true);
  });

  it('returns true for ECONNREFUSED error', () => {
    const error = new Error('connect ECONNREFUSED 127.0.0.1:443');
    expect(isRetryable(error)).toBe(true);
  });

  it('returns false for 400 status', () => {
    const error = { status: 400, message: 'Bad Request' };
    expect(isRetryable(error)).toBe(false);
  });

  it('returns false for 429 status', () => {
    const error = { status: 429, message: 'Rate Limited' };
    expect(isRetryable(error)).toBe(false);
  });

  it('returns false for generic error', () => {
    const error = new Error('some error');
    expect(isRetryable(error)).toBe(false);
  });
});

describe('isRateLimit', () => {
  it('returns true for 429 status', () => {
    expect(isRateLimit({ status: 429 })).toBe(true);
  });

  it('returns true for 429 via statusCode', () => {
    expect(isRateLimit({ statusCode: 429 })).toBe(true);
  });

  it('returns true for 429 via response.status', () => {
    expect(isRateLimit({ response: { status: 429 } })).toBe(true);
  });

  it('returns false for 500 status', () => {
    expect(isRateLimit({ status: 500 })).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds value', () => {
    const error = { headers: { 'retry-after': '5' } };
    expect(parseRetryAfter(error)).toBe(5000);
  });

  it('clamps to 60s max', () => {
    const error = { headers: { 'retry-after': '120' } };
    expect(parseRetryAfter(error)).toBe(60_000);
  });

  it('parses HTTP-date value', () => {
    const futureDate = new Date(Date.now() + 10_000).toUTCString();
    const error = { headers: { 'retry-after': futureDate } };
    const result = parseRetryAfter(error);
    expect(result).toBeDefined();
    // Should be roughly 10s (allow for timing variance)
    if (result !== undefined) {
      expect(result).toBeGreaterThan(8000);
      expect(result).toBeLessThanOrEqual(60_000);
    }
  });

  it('clamps HTTP-date to 60s max', () => {
    const futureDate = new Date(Date.now() + 120_000).toUTCString();
    const error = { headers: { 'retry-after': futureDate } };
    expect(parseRetryAfter(error)).toBe(60_000);
  });

  it('returns undefined when no headers', () => {
    expect(parseRetryAfter(new Error('no headers'))).toBeUndefined();
  });

  it('returns undefined when no retry-after header', () => {
    const error = { headers: { 'content-type': 'application/json' } };
    expect(parseRetryAfter(error)).toBeUndefined();
  });

  it('handles Headers object with get method', () => {
    const headers = new Headers({ 'retry-after': '3' });
    const error = { headers };
    expect(parseRetryAfter(error)).toBe(3000);
  });

  it('returns 0 for past HTTP-date', () => {
    const pastDate = new Date(Date.now() - 10_000).toUTCString();
    const error = { headers: { 'retry-after': pastDate } };
    expect(parseRetryAfter(error)).toBe(0);
  });
});

describe('calculateBackoff', () => {
  it('returns base of 1000ms for retryCount 0', () => {
    // Mock Math.random to return 0 for predictable jitter
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(calculateBackoff(0)).toBe(1000);
    vi.restoreAllMocks();
  });

  it('returns base of 2000ms for retryCount 1', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(calculateBackoff(1)).toBe(2000);
    vi.restoreAllMocks();
  });

  it('returns base of 4000ms for retryCount 2', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(calculateBackoff(2)).toBe(4000);
    vi.restoreAllMocks();
  });

  it('caps at 30000ms base', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(calculateBackoff(10)).toBe(30_000);
    vi.restoreAllMocks();
  });

  it('adds jitter up to 1000ms', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const result = calculateBackoff(0);
    // base 1000 + floor(0.999 * 1000) = 1000 + 999 = 1999
    expect(result).toBe(1999);
    vi.restoreAllMocks();
  });
});

describe('withCanonicalRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result on first successful attempt', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const promise = withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 60_000,
    });

    const result = await promise;
    expect(result.result).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.error).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx error up to maxRetries', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const serverError = Object.assign(new Error('Server Error'), { status: 500 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(serverError)
      .mockRejectedValueOnce(serverError)
      .mockResolvedValue('recovered');

    const promise = withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 120_000,
    });

    // Advance past first backoff (1000ms for retryCount=0)
    await vi.advanceTimersByTimeAsync(1000);
    // Advance past second backoff (2000ms for retryCount=1)
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result.result).toBe('recovered');
    expect(result.attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);

    vi.restoreAllMocks();
  });

  it('fails immediately on 4xx (non-429) error', async () => {
    const clientError = Object.assign(new Error('Bad Request'), { status: 400 });
    const fn = vi.fn().mockRejectedValue(clientError);

    const result = await withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 60_000,
    });

    expect(result.error).toBeDefined();
    expect(result.error?.message).toBe('Bad Request');
    expect(result.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits and resumes on 429 with Retry-After seconds', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const rateLimitError = Object.assign(new Error('Rate Limited'), {
      status: 429,
      headers: { 'retry-after': '2' },
    });
    const fn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('ok');

    const promise = withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 60_000,
    });

    // Advance past the 2s Retry-After wait
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
  });

  it('waits and resumes on 429 with Retry-After HTTP-date', async () => {
    vi.useRealTimers();

    const futureDate = new Date(Date.now() + 100).toUTCString();
    const rateLimitError = Object.assign(new Error('Rate Limited'), {
      status: 429,
      headers: { 'retry-after': futureDate },
    });
    const fn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('ok');

    const result = await withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 60_000,
    });

    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(2);
  });

  it('clamps 429 Retry-After to 60s max', async () => {
    const rateLimitError = Object.assign(new Error('Rate Limited'), {
      status: 429,
      headers: { 'retry-after': '120' },
    });

    const parsed = parseRetryAfter(rateLimitError);
    expect(parsed).toBe(60_000);
  });

  it('uses progressive backoff for 429 when no Retry-After', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const rateLimitError = Object.assign(new Error('Rate Limited'), { status: 429 });
    const fn = vi.fn().mockRejectedValueOnce(rateLimitError).mockResolvedValue('ok');

    const promise = withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 60_000,
    });

    // Without Retry-After, uses calculateBackoff(retryCount=0) = 1000ms
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(2);

    vi.restoreAllMocks();
  });

  it('does not count 429 as a retry but increments totalAttempts', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const rateLimitError = Object.assign(new Error('Rate Limited'), { status: 429 });
    const serverError = Object.assign(new Error('Server Error'), { status: 500 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(serverError)
      .mockResolvedValue('ok');

    const promise = withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 120_000,
    });

    // 429 backoff
    await vi.advanceTimersByTimeAsync(1000);
    // 5xx backoff (retryCount=0 since 429 didn't increment it)
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);

    vi.restoreAllMocks();
  });

  it('retries on ETIMEDOUT error', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const timeoutError = new Error('connect ETIMEDOUT 1.2.3.4:443');
    const fn = vi.fn().mockRejectedValueOnce(timeoutError).mockResolvedValue('ok');

    const promise = withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(2);

    vi.restoreAllMocks();
  });

  it('retries on ECONNRESET error', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const resetError = new Error('read ECONNRESET');
    const fn = vi.fn().mockRejectedValueOnce(resetError).mockResolvedValue('ok');

    const promise = withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(2);

    vi.restoreAllMocks();
  });

  it('retries on ECONNREFUSED error', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const refusedError = new Error('connect ECONNREFUSED 127.0.0.1:443');
    const fn = vi.fn().mockRejectedValueOnce(refusedError).mockResolvedValue('ok');

    const promise = withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(2);

    vi.restoreAllMocks();
  });

  it('respects totalAttempts ceiling of 5', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const serverError = Object.assign(new Error('Server Error'), { status: 500 });
    const fn = vi.fn().mockRejectedValue(serverError);

    const promise = withCanonicalRetry(fn, {
      maxRetries: 10,
      totalAttempts: 10,
      toolTimeoutMs: 600_000,
    });

    // Advance through all backoffs
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(31_000);
    }

    const result = await promise;
    expect(result.error).toBeDefined();
    // totalAttempts clamped to 5, maxRetries=10 but only 4 retries possible (5 attempts - 1 initial)
    expect(result.attempts).toBeLessThanOrEqual(5);
    expect(fn).toHaveBeenCalledTimes(result.attempts);

    vi.restoreAllMocks();
  });

  it('fails when timeout budget has less than 5s remaining', async () => {
    vi.useRealTimers();

    const fn = vi.fn().mockImplementation(async () => {
      return 'ok';
    });

    const result = await withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 3000, // Only 3s total — less than 5s threshold
    });

    // Should fail immediately because remaining < 5s
    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('less than 5s remaining');
    expect(result.attempts).toBe(0);
  });

  it('calls onRetry callback with attempt info', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const serverError = Object.assign(new Error('Server Error'), { status: 500 });
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(serverError).mockResolvedValue('ok');

    const promise = withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 60_000,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.result).toBe('ok');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, serverError, 1000);

    vi.restoreAllMocks();
  });

  it('returns correct attempt count after retries succeed', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const serverError = Object.assign(new Error('Server Error'), { status: 500 });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(serverError)
      .mockRejectedValueOnce(serverError)
      .mockRejectedValueOnce(serverError)
      .mockResolvedValue('finally');

    const promise = withCanonicalRetry(fn, {
      maxRetries: 3,
      totalAttempts: 5,
      toolTimeoutMs: 120_000,
    });

    // retryCount=0: 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // retryCount=1: 2000ms
    await vi.advanceTimersByTimeAsync(2000);
    // retryCount=2: 4000ms
    await vi.advanceTimersByTimeAsync(4000);

    const result = await promise;
    expect(result.result).toBe('finally');
    expect(result.attempts).toBe(4);
    expect(fn).toHaveBeenCalledTimes(4);

    vi.restoreAllMocks();
  });

  it('stops retrying after maxRetries for 5xx errors', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const serverError = Object.assign(new Error('Server Error'), { status: 500 });
    const fn = vi.fn().mockRejectedValue(serverError);

    const promise = withCanonicalRetry(fn, {
      maxRetries: 2,
      totalAttempts: 5,
      toolTimeoutMs: 120_000,
    });

    // retryCount=0: 1000ms
    await vi.advanceTimersByTimeAsync(1000);
    // retryCount=1: 2000ms
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result.error).toBeDefined();
    expect(result.error?.message).toBe('Server Error');
    // 1 initial + 2 retries = 3 attempts
    expect(result.attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);

    vi.restoreAllMocks();
  });

  it('uses default config when none provided', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await withCanonicalRetry(fn);
    expect(result.result).toBe('ok');
    expect(result.attempts).toBe(1);
  });

  it('handles non-Error thrown values', async () => {
    const fn = vi.fn().mockRejectedValue('string error');

    const result = await withCanonicalRetry(fn, {
      maxRetries: 0,
      totalAttempts: 1,
      toolTimeoutMs: 60_000,
    });

    expect(result.error).toBeDefined();
    expect(result.error?.message).toBe('string error');
    expect(result.attempts).toBe(1);
  });
});
