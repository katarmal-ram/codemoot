// packages/core/src/models/fallback.ts

import type { FallbackConfig, ModelCallResult } from '../types/models.js';
import { ModelError } from '../utils/errors.js';
import { sleep } from '../utils/sleep.js';

/**
 * Execute a model call with fallback support.
 *
 * Tries the primary call first. On retryable errors, tries each fallback in order.
 * The `callFn` receives the model alias and must perform the actual model call.
 */
export async function withFallback(
  callFn: (modelAlias: string) => Promise<ModelCallResult>,
  config: FallbackConfig,
): Promise<ModelCallResult> {
  const maxRetries = Math.max(1, config.maxRetries);
  const allModels = [config.primary, ...config.fallbacks];
  let lastError: unknown;

  for (const alias of allModels) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await callFn(alias);
      } catch (error) {
        lastError = error;

        if (!isRetryable(error, config)) {
          throw error;
        }

        // If this was the last retry for this model, move to next fallback
        if (attempt === maxRetries) break;

        // Exponential backoff between retries
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  }

  throw new ModelError(
    `All models failed. Tried: ${allModels.join(', ')}. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function isRetryable(error: unknown, config: FallbackConfig): boolean {
  if (!(error instanceof ModelError)) return false;

  if (config.retryOn.rateLimit && error.isRateLimit) return true;
  if (config.retryOn.timeout && error.isTimeout) return true;
  if (config.retryOn.serverError && error.isServerError) return true;

  return false;
}

