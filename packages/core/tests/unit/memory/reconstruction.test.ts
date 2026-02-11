import { describe, expect, it } from 'vitest';
import { buildReconstructionPrompt } from '../../../src/memory/reconstruction.js';
import type { DebateMessageRow } from '../../../src/memory/message-store.js';

function makeMsg(overrides: Partial<DebateMessageRow> & { round: number }): DebateMessageRow {
  return {
    id: overrides.round,
    debateId: 'test',
    round: overrides.round,
    role: 'critic',
    bridge: 'codex',
    model: 'gpt-5.3',
    promptText: `Prompt for round ${overrides.round}`,
    responseText: `Response for round ${overrides.round}`,
    stance: 'OPPOSE',
    confidence: null,
    verdictRaw: null,
    usageJson: null,
    durationMs: 1000,
    sessionId: 'thread_abc',
    status: 'completed',
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: Date.now(),
    ...overrides,
  };
}

describe('buildReconstructionPrompt', () => {
  it('returns current prompt unchanged when no history', () => {
    const result = buildReconstructionPrompt([], 'New prompt');
    expect(result).toBe('New prompt');
  });

  it('includes previous rounds in preamble', () => {
    const history = [makeMsg({ round: 1 }), makeMsg({ round: 2 })];
    const result = buildReconstructionPrompt(history, 'Round 3 prompt');

    expect(result).toContain('continuation of a debate');
    expect(result).toContain('Round 1');
    expect(result).toContain('Response for round 1');
    expect(result).toContain('Round 2');
    expect(result).toContain('Round 3 prompt');
  });

  it('skips non-completed messages', () => {
    const history = [
      makeMsg({ round: 1 }),
      makeMsg({ round: 2, status: 'failed', responseText: null }),
    ];
    const result = buildReconstructionPrompt(history, 'Round 3');

    expect(result).toContain('Round 1');
    expect(result).not.toContain('Round 2');
  });

  it('includes stance in history', () => {
    const history = [makeMsg({ round: 1, stance: 'SUPPORT' })];
    const result = buildReconstructionPrompt(history, 'Next');

    expect(result).toContain('SUPPORT');
  });

  it('compresses when over maxChars budget', () => {
    const longResponse = 'x'.repeat(500);
    const history = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ round: i + 1, responseText: longResponse }),
    );

    const result = buildReconstructionPrompt(history, 'Current prompt', 5_000);

    expect(result.length).toBeLessThanOrEqual(5_000);
    expect(result).toContain('Current prompt');
    // Should have summary for old rounds
    expect(result).toContain('Summary');
  });

  it('handles extreme budget constraint', () => {
    const history = [makeMsg({ round: 1 })];
    const result = buildReconstructionPrompt(history, 'New', 100);

    expect(result.length).toBeLessThanOrEqual(100);
  });
});
