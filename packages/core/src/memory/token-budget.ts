// packages/core/src/memory/token-budget.ts — Token budget tracking and management for debates

import type { DebateMessageRow } from './message-store.js';

/** Rough estimate: ~4 characters per token for English text. */
const CHARS_PER_TOKEN = 4;

export interface TokenBudgetStatus {
  /** Total tokens used across all rounds. */
  totalTokensUsed: number;
  /** Maximum context tokens for the model. */
  maxContextTokens: number;
  /** Usage as a fraction (0-1). */
  utilizationRatio: number;
  /** Whether auto-summarization is recommended (>= 70%). */
  shouldSummarize: boolean;
  /** Whether the debate should be completed (>= 90%). */
  shouldStop: boolean;
  /** Estimated tokens remaining. */
  tokensRemaining: number;
}

/** Estimate token count from character length. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Calculate total tokens used in a debate from stored messages.
 * Uses actual usage_json when available, falls back to text length estimation.
 */
export function calculateDebateTokens(history: DebateMessageRow[]): number {
  let total = 0;
  for (const msg of history) {
    if (msg.usageJson) {
      try {
        const usage = JSON.parse(msg.usageJson);
        total += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
        continue;
      } catch {
        // Fall through to estimation
      }
    }
    // Estimate from text lengths
    total += estimateTokens(msg.promptText);
    if (msg.responseText) {
      total += estimateTokens(msg.responseText);
    }
  }
  return total;
}

/**
 * Get the current token budget status for a debate.
 */
export function getTokenBudgetStatus(
  history: DebateMessageRow[],
  maxContextTokens: number,
): TokenBudgetStatus {
  const totalTokensUsed = calculateDebateTokens(history);
  const utilizationRatio = maxContextTokens > 0 ? totalTokensUsed / maxContextTokens : 0;

  return {
    totalTokensUsed,
    maxContextTokens,
    utilizationRatio,
    shouldSummarize: utilizationRatio >= 0.7,
    shouldStop: utilizationRatio >= 0.9,
    tokensRemaining: Math.max(0, maxContextTokens - totalTokensUsed),
  };
}

/**
 * Preflight check: estimate if a new prompt will fit within budget.
 * Returns the status AFTER the hypothetical send.
 */
export function preflightTokenCheck(
  history: DebateMessageRow[],
  newPrompt: string,
  maxContextTokens: number,
): TokenBudgetStatus {
  const currentTokens = calculateDebateTokens(history);
  const promptTokens = estimateTokens(newPrompt);
  const projected = currentTokens + promptTokens;
  const utilizationRatio = maxContextTokens > 0 ? projected / maxContextTokens : 0;

  return {
    totalTokensUsed: projected,
    maxContextTokens,
    utilizationRatio,
    shouldSummarize: utilizationRatio >= 0.7,
    shouldStop: utilizationRatio >= 0.9,
    tokensRemaining: Math.max(0, maxContextTokens - projected),
  };
}
