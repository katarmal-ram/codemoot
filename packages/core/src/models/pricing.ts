// packages/core/src/models/pricing.ts

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

/**
 * Static pricing table for known models (USD per 1M tokens).
 * Updated: 2026-02.
 */
const PRICING: Record<string, ModelPricing> = {
  // OpenAI
  'gpt-5': { inputPer1M: 5, outputPer1M: 15 },
  'gpt-5-mini': { inputPer1M: 0.3, outputPer1M: 1.2 },
  o3: { inputPer1M: 10, outputPer1M: 40 },
  'o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
};

export function getModelPricing(modelId: string): ModelPricing | null {
  return PRICING[modelId] ?? null;
}

/**
 * Calculate cost in USD for a model call.
 * Returns 0 if the model is not in the pricing table.
 */
export function calculateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const pricing = getModelPricing(modelId);
  if (!pricing) return 0;
  return (inputTokens * pricing.inputPer1M + outputTokens * pricing.outputPer1M) / 1_000_000;
}
