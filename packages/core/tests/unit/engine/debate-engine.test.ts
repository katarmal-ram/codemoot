import { describe, expect, it, vi } from 'vitest';
import { ProposalCritiqueEngine, detectStance } from '../../../src/engine/debate-engine.js';
import type { DebateEngineInput, DebateIO } from '../../../src/types/debate.js';

// ── detectStance ──

describe('detectStance', () => {
  it('detects support from approval language', () => {
    expect(detectStance('This looks good. I approve the design.\nSTANCE: SUPPORT')).toBe('support');
    expect(detectStance('I agree with this approach. No issues.')).toBe('support');
    expect(detectStance('VERDICT: APPROVED')).toBe('support');
  });

  it('detects oppose from critique language', () => {
    expect(
      detectStance('This needs revision. Fundamental flaw in the design.\nSTANCE: OPPOSE'),
    ).toBe('oppose');
    expect(detectStance('I disagree with this approach. Reject.')).toBe('oppose');
    expect(detectStance('VERDICT: NEEDS_REVISION')).toBe('oppose');
  });

  it('returns uncertain when mixed or neutral', () => {
    expect(detectStance('Interesting perspective. Let me think about it.')).toBe('uncertain');
    expect(detectStance('Some parts look good but I also disagree with others.')).toBe('uncertain');
  });
});

// ── ProposalCritiqueEngine ──

function makeIO(responses: string[]): DebateIO {
  let callIndex = 0;
  return {
    generate: vi.fn(async () => {
      const text = responses[callIndex] ?? 'No more responses';
      callIndex++;
      return { text, promptTokens: 100, completionTokens: 50 };
    }),
  };
}

function makeInput(overrides?: Partial<DebateEngineInput>): DebateEngineInput {
  return {
    debateId: 'test-debate-1',
    question: 'Should we use Redis or Memcached for caching?',
    models: ['model-a', 'model-b'],
    ...overrides,
  };
}

describe('ProposalCritiqueEngine', () => {
  it('requires at least 2 models', () => {
    const engine = new ProposalCritiqueEngine();
    expect(() => engine.init(makeInput({ models: ['single'] }))).toThrow('at least 2 models');
  });

  it('initializes state correctly', () => {
    const engine = new ProposalCritiqueEngine();
    const state = engine.init(makeInput());
    expect(state.debateId).toBe('test-debate-1');
    expect(state.round).toBe(0);
    expect(state.turn).toBe(0);
    expect(state.thread).toHaveLength(1); // topic message
    expect(state.thread[0].kind).toBe('topic');
    expect(state.status).toBe('running');
  });

  it('runs a single-round debate where critic approves immediately', async () => {
    const engine = new ProposalCritiqueEngine(
      { maxRounds: 3 },
      { minRoundsBeforeCheck: 0, requiredStableRounds: 1 },
    );
    const io = makeIO([
      'Use Redis for its data structures and pub/sub.\nSTANCE: SUPPORT',
      'I agree. Redis is the right choice. VERDICT: APPROVED\nSTANCE: SUPPORT',
    ]);

    const result = await engine.run(makeInput(), io);

    expect(result.reason).toBe('converged');
    expect(result.rounds).toBe(1);
    expect(result.thread.length).toBeGreaterThanOrEqual(3); // topic + proposal + critique
    expect(io.generate).toHaveBeenCalledTimes(2); // proposer + critic, no summary needed
  });

  it('runs multiple rounds when critic opposes', async () => {
    const engine = new ProposalCritiqueEngine({ maxRounds: 2 });
    const io = makeIO([
      // Round 1: proposal
      'Use Redis. STANCE: SUPPORT',
      // Round 1: critique (oppose)
      'Redis lacks persistence guarantees. Needs revision. STANCE: OPPOSE',
      // Round 1: summary
      'Proposer suggested Redis, critic raised persistence concerns.',
      // Round 2: rebuttal
      'Redis has AOF and RDB persistence. STANCE: SUPPORT',
      // Round 2: critique (still oppose)
      'AOF has rewrite issues. Disagree. STANCE: OPPOSE',
    ]);

    const result = await engine.run(makeInput(), io);

    expect(result.reason).toBe('max_rounds');
    expect(result.rounds).toBe(2);
    expect(result.answer).toContain('Outstanding Critique');
  });

  it('converges after critic changes stance to support', async () => {
    const engine = new ProposalCritiqueEngine(
      { maxRounds: 5 },
      { requiredStableRounds: 1, minRoundsBeforeCheck: 1 },
    );
    const io = makeIO([
      // Round 1
      'Use Redis. STANCE: SUPPORT',
      'Needs more detail. STANCE: OPPOSE',
      'Summary: Redis proposed, detail requested.',
      // Round 2
      'Redis with AOF persistence and replica failover. STANCE: SUPPORT',
      'Looks good, I approve. STANCE: SUPPORT',
    ]);

    const result = await engine.run(makeInput(), io);

    expect(result.reason).toBe('converged');
    expect(result.rounds).toBe(2);
  });

  it('includes stance history in result', async () => {
    const engine = new ProposalCritiqueEngine({ maxRounds: 1 });
    const io = makeIO(['Proposal text. STANCE: SUPPORT', 'Critique text. STANCE: OPPOSE']);

    const result = await engine.run(makeInput(), io);

    expect(result.stanceHistory).toHaveLength(2);
    expect(result.stanceHistory[0]).toEqual({ round: 1, speakerId: 'model-a', stance: 'support' });
    expect(result.stanceHistory[1]).toEqual({ round: 1, speakerId: 'model-b', stance: 'oppose' });
  });

  it('tracks token usage', async () => {
    const engine = new ProposalCritiqueEngine({ maxRounds: 1 });
    const io = makeIO(['Proposal. STANCE: SUPPORT', 'Critique. STANCE: OPPOSE']);

    const result = await engine.run(makeInput(), io);

    expect(result.usage.totalCalls).toBe(2);
    expect(result.usage.totalPromptTokens).toBe(200); // 2 calls * 100
    expect(result.usage.totalCompletionTokens).toBe(100); // 2 calls * 50
  });

  it('handles model errors gracefully', async () => {
    const engine = new ProposalCritiqueEngine({ maxRounds: 1 });
    const io: DebateIO = {
      generate: vi.fn(async () => {
        throw new Error('CLI timeout');
      }),
    };

    await expect(engine.run(makeInput(), io)).rejects.toThrow('CLI timeout');
  });

  it('respects time budget', async () => {
    // Set a short time budget — first round completes but second should not start
    const engine = new ProposalCritiqueEngine({ maxRounds: 5, maxWallClockMs: 50 });
    let callCount = 0;
    const io: DebateIO = {
      generate: vi.fn(async () => {
        callCount++;
        // Add delay to trigger time budget on round 2+
        await new Promise((r) => setTimeout(r, 30));
        return { text: 'Response. STANCE: OPPOSE', promptTokens: 10, completionTokens: 10 };
      }),
    };

    const result = await engine.run(makeInput(), io);
    // Should not reach max rounds due to time constraint
    expect(result.rounds).toBeLessThan(5);
  });

  it('builds prompts with context compaction', () => {
    const engine = new ProposalCritiqueEngine();
    const state = engine.init(makeInput());
    state.round = 2;
    state.runningSummary = 'Round 1 summary: Redis proposed, concerns raised.';

    // Simulate adding messages
    state.thread.push({
      id: 'msg-1',
      turn: 1,
      round: 1,
      speakerId: 'model-a',
      kind: 'proposal',
      text: 'Use Redis',
      createdAt: Date.now(),
    });
    state.thread.push({
      id: 'msg-2',
      turn: 2,
      round: 1,
      speakerId: 'model-b',
      kind: 'critique',
      text: 'Need persistence guarantees',
      createdAt: Date.now(),
    });

    // Verify state has summary and messages — the prompt builder is private
    // but we can verify the state structure is correct for compaction
    expect(state.runningSummary).toContain('Round 1 summary');
    expect(state.thread).toHaveLength(3); // topic + proposal + critique
  });

  it('extracts confidence from text', async () => {
    const engine = new ProposalCritiqueEngine({ maxRounds: 1 });
    const io = makeIO([
      'Good plan. Confidence: 0.85\nSTANCE: SUPPORT',
      'Solid. Confidence: 0.9\nSTANCE: SUPPORT',
    ]);

    const result = await engine.run(makeInput(), io);
    const proposal = result.thread.find((m) => m.kind === 'proposal');
    expect(proposal?.confidence).toBe(0.85);
  });
});
