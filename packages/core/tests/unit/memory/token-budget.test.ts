import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  calculateDebateTokens,
  getTokenBudgetStatus,
  preflightTokenCheck,
} from '../../../src/memory/token-budget.js';
import type { DebateMessageRow } from '../../../src/memory/message-store.js';

function makeMsg(overrides: Partial<DebateMessageRow> & { round: number }): DebateMessageRow {
  return {
    id: overrides.round,
    debateId: 'test',
    round: overrides.round,
    role: 'critic',
    bridge: 'codex',
    model: 'gpt-5.3',
    promptText: 'a'.repeat(400), // ~100 tokens
    responseText: 'b'.repeat(400), // ~100 tokens
    stance: null,
    confidence: null,
    verdictRaw: null,
    usageJson: null,
    durationMs: 1000,
    sessionId: null,
    status: 'completed',
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: Date.now(),
    ...overrides,
  };
}

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('hello')).toBe(2); // ceil(5/4)
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('calculateDebateTokens', () => {
  it('uses only output tokens from usage_json (input tokens inflated by sandbox)', () => {
    const msgs = [makeMsg({ round: 1, usageJson: '{"inputTokens":500,"outputTokens":200}' })];
    expect(calculateDebateTokens(msgs)).toBe(200);
  });

  it('falls back to text estimation when no usage_json', () => {
    const msgs = [makeMsg({ round: 1 })];
    // 400 chars prompt + 400 chars response = 800 chars / 4 = 200 tokens
    expect(calculateDebateTokens(msgs)).toBe(200);
  });

  it('sums output tokens across multiple rounds', () => {
    const msgs = [
      makeMsg({ round: 1, usageJson: '{"inputTokens":100,"outputTokens":50}' }),
      makeMsg({ round: 2, usageJson: '{"inputTokens":200,"outputTokens":100}' }),
    ];
    expect(calculateDebateTokens(msgs)).toBe(150);
  });

  it('handles malformed usage_json gracefully', () => {
    const msgs = [makeMsg({ round: 1, usageJson: 'bad json' })];
    // Falls back to estimation
    expect(calculateDebateTokens(msgs)).toBe(200);
  });
});

describe('getTokenBudgetStatus', () => {
  it('calculates utilization ratio from output tokens only', () => {
    const msgs = [makeMsg({ round: 1, usageJson: '{"inputTokens":50000,"outputTokens":7000}' })];
    const status = getTokenBudgetStatus(msgs, 10_000);

    expect(status.totalTokensUsed).toBe(7000);
    expect(status.utilizationRatio).toBe(0.7);
    expect(status.shouldSummarize).toBe(true);
    expect(status.shouldStop).toBe(false);
    expect(status.tokensRemaining).toBe(3000);
  });

  it('triggers stop at 90%', () => {
    const msgs = [makeMsg({ round: 1, usageJson: '{"inputTokens":50000,"outputTokens":9000}' })];
    const status = getTokenBudgetStatus(msgs, 10_000);

    expect(status.shouldStop).toBe(true);
  });

  it('handles empty history', () => {
    const status = getTokenBudgetStatus([], 128_000);
    expect(status.totalTokensUsed).toBe(0);
    expect(status.utilizationRatio).toBe(0);
    expect(status.shouldSummarize).toBe(false);
  });
});

describe('preflightTokenCheck', () => {
  it('projects token usage with new prompt (output tokens + prompt estimate)', () => {
    const msgs = [makeMsg({ round: 1, usageJson: '{"inputTokens":50000,"outputTokens":5000}' })];
    const newPrompt = 'a'.repeat(4000); // ~1000 tokens

    const status = preflightTokenCheck(msgs, newPrompt, 10_000);

    expect(status.totalTokensUsed).toBe(6000);
    expect(status.shouldSummarize).toBe(false);
  });

  it('warns when new prompt pushes over 70%', () => {
    const msgs = [makeMsg({ round: 1, usageJson: '{"inputTokens":50000,"outputTokens":6000}' })];
    const newPrompt = 'a'.repeat(4000); // ~1000 tokens → 7000 total

    const status = preflightTokenCheck(msgs, newPrompt, 10_000);

    expect(status.shouldSummarize).toBe(true);
  });
});
