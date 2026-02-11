// packages/core/src/security/retry.ts — Canonical retry policy from MCP architecture

import { HTTP_TOO_MANY_REQUESTS } from '../utils/constants.js';
import { sleep } from '../utils/sleep.js';

export interface RetryConfig {
  maxRetries: number;
  totalAttempts: number;
  toolTimeoutMs: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export interface AttemptResult<T> {
  result?: T;
  error?: Error;
  attempts: number;
  totalElapsedMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  totalAttempts: 5,
  toolTimeoutMs: 600_000,
  onRetry: undefined,
};

/**
 * Check if an error represents an HTTP 5xx or retryable network error.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED')) {
      return true;
    }
  }
  const status = getStatusCode(error);
  if (status !== undefined && status >= 500) {
    return true;
  }
  return false;
}

/**
 * Check if an error represents an HTTP 429 rate limit.
 */
export function isRateLimit(error: unknown): boolean {
  return getStatusCode(error) === HTTP_TOO_MANY_REQUESTS;
}

/**
 * Parse the Retry-After header value from an error, clamped to 60s max.
 * Returns delay in milliseconds, or undefined if not found.
 */
export function parseRetryAfter(error: unknown): number | undefined {
  const headers = getHeaders(error);
  if (!headers) {
    return undefined;
  }

  const retryAfter =
    typeof headers.get === 'function'
      ? headers.get('retry-after')
      : (headers as Record<string, string>)['retry-after'];

  if (!retryAfter) {
    return undefined;
  }

  // Try parsing as seconds (integer)
  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 60_000);
  }

  // Try parsing as HTTP-date
  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) {
    const delayMs = dateMs - Date.now();
    if (delayMs <= 0) {
      return 0;
    }
    return Math.min(delayMs, 60_000);
  }

  return undefined;
}

/**
 * Calculate exponential backoff with jitter.
 * Formula: min(1000 * 2^retryCount, 30000) + random jitter [0, 1000]ms
 */
export function calculateBackoff(retryCount: number): number {
  const base = Math.min(1000 * 2 ** retryCount, 30_000);
  const jitter = Math.floor(Math.random() * 1000);
  return base + jitter;
}

/**
 * Execute fn with canonical retry policy:
 * - totalAttempts <= 5 (absolute ceiling)
 * - 5xx -> retry (up to maxRetries)
 * - 429 -> wait-and-resume (parse Retry-After, clamp to 60s, progressive wait if missing)
 * - 4xx (except 429) -> fail immediately
 * - ETIMEDOUT, ECONNRESET, ECONNREFUSED -> retry
 * - Backoff: min(1000 * 2^retryCount, 30000) + random jitter [0, 1000]ms
 * - Timeout budget: if remaining < 5s, fail immediately
 */
export async function withCanonicalRetry<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
): Promise<AttemptResult<T>> {
  const cfg: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  // Enforce absolute ceiling
  if (cfg.totalAttempts > 5) {
    cfg.totalAttempts = 5;
  }

  const startTime = Date.now();
  let retryCount = 0;
  let attemptCount = 0;

  while (attemptCount < cfg.totalAttempts) {
    // Check timeout budget before each attempt
    const elapsed = Date.now() - startTime;
    const remaining = cfg.toolTimeoutMs - elapsed;
    if (remaining < 5000) {
      return {
        error: new Error('Timeout budget exhausted: less than 5s remaining'),
        attempts: attemptCount,
        totalElapsedMs: Date.now() - startTime,
      };
    }

    attemptCount++;

    try {
      const result = await fn();
      return {
        result,
        attempts: attemptCount,
        totalElapsedMs: Date.now() - startTime,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // 429 rate limit: wait and resume (does NOT count as a retry, but counts as attempt)
      if (isRateLimit(err)) {
        const retryAfterMs = parseRetryAfter(err);
        const delayMs = retryAfterMs ?? calculateBackoff(retryCount);

        if (cfg.onRetry) {
          cfg.onRetry(attemptCount, err, delayMs);
        }

        await sleep(delayMs);
        // Do not increment retryCount for 429
        continue;
      }

      // 5xx or network error: retry with backoff
      if (isRetryable(err) && retryCount < cfg.maxRetries) {
        const delayMs = calculateBackoff(retryCount);

        if (cfg.onRetry) {
          cfg.onRetry(attemptCount, err, delayMs);
        }

        retryCount++;
        await sleep(delayMs);
        continue;
      }

      // 4xx (non-429) or exhausted retries: fail immediately
      return {
        error,
        attempts: attemptCount,
        totalElapsedMs: Date.now() - startTime,
      };
    }
  }

  // Should not reach here, but safety net
  return {
    error: new Error('All attempts exhausted'),
    attempts: attemptCount,
    totalElapsedMs: Date.now() - startTime,
  };
}

// -- Internal helpers --

function getStatusCode(error: unknown): number | undefined {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
    if (e.response && typeof e.response === 'object') {
      const resp = e.response as Record<string, unknown>;
      if (typeof resp.status === 'number') return resp.status;
      if (typeof resp.statusCode === 'number') return resp.statusCode;
    }
  }
  return undefined;
}

function getHeaders(error: unknown): Record<string, string> | Headers | undefined {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (e.headers && typeof e.headers === 'object') {
      return e.headers as Record<string, string> | Headers;
    }
    if (e.response && typeof e.response === 'object') {
      const resp = e.response as Record<string, unknown>;
      if (resp.headers && typeof resp.headers === 'object') {
        return resp.headers as Record<string, string> | Headers;
      }
    }
  }
  return undefined;
}

