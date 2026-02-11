// packages/core/src/models/cost-tracker.ts

import type { CostStore } from '../memory/cost-store.js';
import type { ModelCallResult } from '../types/models.js';

/**
 * Wraps model calls and records cost/usage to the CostStore.
 * Created per-session by the Orchestrator.
 */
export class CostTracker {
  constructor(
    private costStore: CostStore,
    private sessionId: string,
  ) {}

  /**
   * Execute a model call and record its cost.
   * Usage: `costTracker.tracked(() => callModel(model, msgs, opts), 'plan')`
   */
  async tracked(fn: () => Promise<ModelCallResult>, stepId?: string): Promise<ModelCallResult> {
    const result = await fn();
    this.record(result, stepId);
    return result;
  }

  /** Record usage from an already-completed model call. */
  record(result: ModelCallResult, stepId?: string): void {
    this.costStore.log({
      sessionId: this.sessionId,
      stepId: stepId ?? null,
      modelId: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
      latencyMs: result.durationMs,
    });
  }
}
