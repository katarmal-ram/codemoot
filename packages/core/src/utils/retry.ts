// packages/core/src/utils/retry.ts

import { sleep } from './sleep.js';

export interface RetryOptions {
  attempts: number;
  backoff: number;
  retryOn?: (error: unknown) => boolean;
}

const defaultOptions: RetryOptions = {
  attempts: 3,
  backoff: 1000,
};

/**
 * Retry an async function with exponential backoff.
 * Returns the result on success, throws the last error after all attempts exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  const opts = { ...defaultOptions, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (opts.retryOn && !opts.retryOn(error)) {
        throw error;
      }

      if (attempt < opts.attempts) {
        const delay = opts.backoff * 2 ** (attempt - 1);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

