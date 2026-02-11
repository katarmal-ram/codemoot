import { describe, expect, it, vi } from 'vitest';
import { withFallback } from '../../../src/models/fallback.js';
import type { FallbackConfig, ModelCallResult } from '../../../src/types/models.js';
import { ModelError } from '../../../src/utils/errors.js';

const makeResult = (model: string): ModelCallResult => ({
  text: `Response from ${model}`,
  model,
  provider: 'openai',
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001 },
  finishReason: 'stop',
  durationMs: 100,
});

const defaultFallbackConfig: FallbackConfig = {
  primary: 'primary-model',
  fallbacks: ['fallback-1', 'fallback-2'],
  maxRetries: 2,
  retryOn: {
    rateLimit: true,
    timeout: true,
    serverError: true,
  },
};

describe('withFallback', () => {
  it('returns primary result on success', async () => {
    const callFn = vi.fn(async (alias: string) => makeResult(alias));

    const result = await withFallback(callFn, defaultFallbackConfig);

    expect(result.model).toBe('primary-model');
    expect(callFn).toHaveBeenCalledTimes(1);
    expect(callFn).toHaveBeenCalledWith('primary-model');
  });

  it('falls back on rate limit (429)', async () => {
    let callCount = 0;
    const callFn = vi.fn(async (alias: string) => {
      callCount++;
      if (alias === 'primary-model') {
        throw new ModelError('Rate limited', 'openai', 'gpt-5', 429);
      }
      return makeResult(alias);
    });

    const result = await withFallback(callFn, defaultFallbackConfig);

    // Primary retried maxRetries times, then fallback-1 succeeds
    expect(result.model).toBe('fallback-1');
  });

  it('falls back on server error (500)', async () => {
    const callFn = vi.fn(async (alias: string) => {
      if (alias === 'primary-model') {
        throw new ModelError('Internal server error', 'openai', 'gpt-5', 500);
      }
      return makeResult(alias);
    });

    const result = await withFallback(callFn, defaultFallbackConfig);
    expect(result.model).toBe('fallback-1');
  });

  it('falls back on timeout', async () => {
    const callFn = vi.fn(async (alias: string) => {
      if (alias === 'primary-model') {
        throw new ModelError('Request timeout', 'openai', 'gpt-5');
      }
      return makeResult(alias);
    });

    const result = await withFallback(callFn, defaultFallbackConfig);
    expect(result.model).toBe('fallback-1');
  });

  it('throws immediately on non-retryable error', async () => {
    const callFn = vi.fn(async () => {
      throw new ModelError('Invalid API key', 'openai', 'gpt-5', 401);
    });

    await expect(withFallback(callFn, defaultFallbackConfig)).rejects.toThrow('Invalid API key');
    // Should only try once since 401 is not retryable
    expect(callFn).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on non-ModelError', async () => {
    const callFn = vi.fn(async () => {
      throw new Error('Some random error');
    });

    await expect(withFallback(callFn, defaultFallbackConfig)).rejects.toThrow('Some random error');
    expect(callFn).toHaveBeenCalledTimes(1);
  });

  it('throws after all models fail', async () => {
    const callFn = vi.fn(async () => {
      throw new ModelError('Rate limited', 'openai', 'gpt-5', 429);
    });

    await expect(withFallback(callFn, defaultFallbackConfig)).rejects.toThrow('All models failed');
  });

  it('tries second fallback when first also fails', async () => {
    const callFn = vi.fn(async (alias: string) => {
      if (alias === 'primary-model' || alias === 'fallback-1') {
        throw new ModelError('Rate limited', 'openai', alias, 429);
      }
      return makeResult(alias);
    });

    const result = await withFallback(callFn, defaultFallbackConfig);
    expect(result.model).toBe('fallback-2');
  });

  it('respects retryOn config (does not retry disabled errors)', async () => {
    const config: FallbackConfig = {
      ...defaultFallbackConfig,
      retryOn: { rateLimit: false, timeout: true, serverError: true },
    };

    const callFn = vi.fn(async () => {
      throw new ModelError('Rate limited', 'openai', 'gpt-5', 429);
    });

    // Rate limit retry is disabled, so it should throw immediately
    await expect(withFallback(callFn, config)).rejects.toThrow('Rate limited');
    expect(callFn).toHaveBeenCalledTimes(1);
  });
});
