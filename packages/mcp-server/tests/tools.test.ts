// packages/mcp-server/tests/tools.test.ts — MCP tool handler tests

import type { CancellationToken, CostStore, MemoryStore, Orchestrator } from '@codemoot/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { handleCost } from '../src/tools/cost.js';
import { handleDebate } from '../src/tools/debate.js';
import { handleMemory } from '../src/tools/memory.js';
import { handlePlan } from '../src/tools/plan.js';
import { handleReview } from '../src/tools/review.js';

// -- Mock factories --

function createMockOrchestrator(overrides?: Record<string, unknown>) {
  return {
    review: vi.fn(async () => ({
      status: 'success',
      score: 8,
      verdict: 'approved',
      feedback: ['Looks good', 'Clean code'],
      tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.002 },
      latencyMs: 450,
      meteringSource: 'billed',
      model: 'claude-sonnet-4-5-20250929',
      egressControl: 'codemoot-enforced',
    })),
    plan: vi.fn(async () => ({
      sessionId: 'sess-001',
      status: 'completed',
      finalOutput: '## Plan\n1. Step one\n2. Step two',
      totalCost: 0.005,
      totalTokens: 600,
      durationMs: 3200,
      iterations: 2,
    })),
    debate: vi.fn(async () => ({
      status: 'success',
      responses: [
        {
          model: 'claude-sonnet-4-5-20250929',
          role: 'claude-sonnet',
          text: 'I think option A is better.',
          tokenUsage: { inputTokens: 80, outputTokens: 40, totalTokens: 120, costUsd: 0.001 },
          latencyMs: 300,
          meteringSource: 'billed',
        },
        {
          model: 'gpt-5',
          role: 'gpt-5',
          text: 'I prefer option B.',
          tokenUsage: { inputTokens: 80, outputTokens: 35, totalTokens: 115, costUsd: 0.001 },
          latencyMs: 280,
          meteringSource: 'billed',
        },
      ],
      totalTokenUsage: { inputTokens: 160, outputTokens: 75, totalTokens: 235, costUsd: 0.002 },
      partialFailure: false,
      egressControl: 'codemoot-enforced',
    })),
    debateMultiRound: vi.fn(async () => ({
      debateId: 'debate_123',
      answer: 'Use Redis for caching.',
      reason: 'converged',
      rounds: 2,
      thread: [
        { id: 't1', turn: 0, round: 0, speakerId: 'user', kind: 'topic', text: 'Test question', createdAt: Date.now() },
        { id: 't2', turn: 1, round: 1, speakerId: 'model-a', kind: 'proposal', text: 'Use Redis.', createdAt: Date.now() },
        { id: 't3', turn: 2, round: 1, speakerId: 'model-b', kind: 'critique', text: 'Approved.', createdAt: Date.now() },
      ],
      stanceHistory: [
        { round: 1, speakerId: 'model-a', stance: 'support' },
        { round: 1, speakerId: 'model-b', stance: 'support' },
      ],
      usage: { totalPromptTokens: 200, totalCompletionTokens: 100, totalCalls: 2, startedAt: Date.now() },
    })),
    ...overrides,
  } as unknown as Orchestrator;
}

function createMockMemoryStore(overrides?: Record<string, unknown>) {
  return {
    save: vi.fn(() => 42),
    search: vi.fn(() => [
      {
        id: 1,
        projectId: 'test-project',
        category: 'decision',
        content: 'Use TypeScript for all new code',
        sourceSessionId: null,
        importance: 0.8,
        createdAt: '2026-02-10T00:00:00Z',
        accessedAt: '2026-02-10T00:00:00Z',
        accessCount: 3,
      },
    ]),
    getById: vi.fn((id: number) => {
      if (id === 1) {
        return {
          id: 1,
          projectId: 'test-project',
          category: 'decision',
          content: 'Use TypeScript for all new code',
          sourceSessionId: null,
          importance: 0.8,
          createdAt: '2026-02-10T00:00:00Z',
          accessedAt: '2026-02-10T00:00:00Z',
          accessCount: 3,
        };
      }
      return null;
    }),
    recordAccess: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  } as unknown as MemoryStore;
}

function createMockCostStore(overrides?: Record<string, unknown>) {
  return {
    getSessionSummary: vi.fn(() => [
      {
        modelId: 'claude-sonnet-4-5-20250929',
        callCount: 3,
        totalInputTokens: 500,
        totalOutputTokens: 300,
        totalCost: 0.008,
        avgLatencyMs: 420,
      },
    ]),
    getDailySummary: vi.fn(() => [
      {
        day: '2026-02-10',
        model_id: 'claude-sonnet-4-5-20250929',
        input_tokens: 2000,
        output_tokens: 1200,
        cost: 0.035,
        api_calls: 12,
      },
    ]),
    ...overrides,
  } as unknown as CostStore;
}

function createMockCancellationToken(): CancellationToken {
  return {
    isCancelled: false,
    cancel: vi.fn(),
    throwIfCancelled: vi.fn(),
    onCancel: vi.fn(),
    offCancel: vi.fn(),
    sleep: vi.fn(async () => true),
  } as unknown as CancellationToken;
}

// -- Tests --

describe('handleReview', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = createMockOrchestrator();
  });

  it('returns ReviewResult with score and verdict for valid input', async () => {
    const result = await handleReview(orchestrator, {
      content: 'function add(a, b) { return a + b; }',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('success');
    expect(parsed.score).toBe(8);
    expect(parsed.verdict).toBe('approved');
    expect(parsed.feedback).toEqual(['Looks good', 'Clean code']);
  });

  it('passes criteria and strict options to orchestrator', async () => {
    const token = createMockCancellationToken();
    await handleReview(
      orchestrator,
      { content: 'code', criteria: ['security', 'performance'], strict: false, timeout: 60 },
      token,
    );

    const reviewFn = orchestrator.review as ReturnType<typeof vi.fn>;
    expect(reviewFn).toHaveBeenCalledWith(
      'code',
      { criteria: ['security', 'performance'], strict: false, timeout: 60 },
      token,
    );
  });

  it('throws ZodError when content is missing', async () => {
    await expect(handleReview(orchestrator, {})).rejects.toThrow(ZodError);
  });

  it('throws ZodError when content exceeds 100K characters', async () => {
    const oversized = 'x'.repeat(100_001);
    await expect(handleReview(orchestrator, { content: oversized })).rejects.toThrow(ZodError);
  });

  it('throws ZodError when content is empty string', async () => {
    await expect(handleReview(orchestrator, { content: '' })).rejects.toThrow(ZodError);
  });

  it('passes cancellation token to orchestrator', async () => {
    const token = createMockCancellationToken();
    await handleReview(orchestrator, { content: 'test code' }, token);

    const reviewFn = orchestrator.review as ReturnType<typeof vi.fn>;
    expect(reviewFn.mock.calls[0][2]).toBe(token);
  });

  it('propagates orchestrator errors', async () => {
    const failOrch = createMockOrchestrator({
      review: vi.fn(async () => {
        throw new Error('Model unavailable');
      }),
    });
    await expect(handleReview(failOrch, { content: 'test' })).rejects.toThrow('Model unavailable');
  });
});

describe('handlePlan', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = createMockOrchestrator();
  });

  it('returns SessionResult for valid task', async () => {
    const result = await handlePlan(orchestrator, { task: 'Build authentication system' });

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.sessionId).toBe('sess-001');
    expect(parsed.status).toBe('completed');
    expect(parsed.iterations).toBe(2);
  });

  it('passes maxRounds and stream options', async () => {
    await handlePlan(orchestrator, { task: 'Build auth', maxRounds: 5, stream: true });

    const planFn = orchestrator.plan as ReturnType<typeof vi.fn>;
    expect(planFn).toHaveBeenCalledWith('Build auth', { maxRounds: 5, stream: true });
  });

  it('throws ZodError when task is empty', async () => {
    await expect(handlePlan(orchestrator, { task: '' })).rejects.toThrow(ZodError);
  });

  it('throws ZodError when task is missing', async () => {
    await expect(handlePlan(orchestrator, {})).rejects.toThrow(ZodError);
  });

  it('throws ZodError when maxRounds exceeds 10', async () => {
    await expect(handlePlan(orchestrator, { task: 'test', maxRounds: 15 })).rejects.toThrow(
      ZodError,
    );
  });

  it('propagates orchestrator errors', async () => {
    const failOrch = createMockOrchestrator({
      plan: vi.fn(async () => {
        throw new Error('Workflow not found');
      }),
    });
    await expect(handlePlan(failOrch, { task: 'test' })).rejects.toThrow('Workflow not found');
  });
});

describe('handleDebate', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    orchestrator = createMockOrchestrator();
  });

  it('returns DebateResult with responses for valid input', async () => {
    const result = await handleDebate(orchestrator, {
      question: 'Should we use REST or GraphQL?',
      models: ['claude-sonnet', 'gpt-5'],
    });

    expect(result.content).toHaveLength(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.debateId).toBe('debate_123');
    expect(parsed.reason).toBe('converged');
    expect(parsed.rounds).toBe(2);
    expect(parsed.thread).toHaveLength(3);
  });

  it('passes modelAliases and maxRounds options', async () => {
    await handleDebate(orchestrator, {
      question: 'Best framework?',
      models: ['claude-sonnet', 'gpt-5'],
      synthesize: true,
      maxRounds: 5,
      timeout: 60,
    });

    const debateFn = orchestrator.debateMultiRound as ReturnType<typeof vi.fn>;
    expect(debateFn).toHaveBeenCalledWith(
      'Best framework?',
      { modelAliases: ['claude-sonnet', 'gpt-5'], maxRounds: 5, timeout: 60 },
    );
  });

  it('throws ZodError when question is missing', async () => {
    await expect(handleDebate(orchestrator, {})).rejects.toThrow(ZodError);
  });

  it('throws ZodError when question is empty', async () => {
    await expect(handleDebate(orchestrator, { question: '' })).rejects.toThrow(ZodError);
  });

  it('throws ZodError when 0 models specified', async () => {
    await expect(handleDebate(orchestrator, { question: 'test?', models: [] })).rejects.toThrow(
      ZodError,
    );
  });

  it('throws ZodError when more than 5 models specified', async () => {
    await expect(
      handleDebate(orchestrator, {
        question: 'test?',
        models: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
      }),
    ).rejects.toThrow(ZodError);
  });

  it('calls debateMultiRound with default maxRounds', async () => {
    await handleDebate(orchestrator, { question: 'test?', models: ['a', 'b'] });

    const debateFn = orchestrator.debateMultiRound as ReturnType<typeof vi.fn>;
    expect(debateFn).toHaveBeenCalledWith(
      'test?',
      { modelAliases: ['a', 'b'], maxRounds: 3, timeout: 600 },
    );
  });
});

describe('handleMemory', () => {
  let memoryStore: MemoryStore;
  const projectId = 'test-project';

  beforeEach(() => {
    memoryStore = createMockMemoryStore();
  });

  it('save returns saved ID', async () => {
    const result = await handleMemory(memoryStore, projectId, {
      action: 'save',
      content: 'Always use ESM imports',
      category: 'convention',
      importance: 0.9,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe(42);
    expect(parsed.saved).toBe(true);

    const saveFn = memoryStore.save as ReturnType<typeof vi.fn>;
    expect(saveFn).toHaveBeenCalledWith({
      projectId: 'test-project',
      category: 'convention',
      content: 'Always use ESM imports',
      sourceSessionId: null,
      importance: 0.9,
    });
  });

  it('save throws when content is missing', async () => {
    await expect(handleMemory(memoryStore, projectId, { action: 'save' })).rejects.toThrow(
      'content is required for save action',
    );
  });

  it('search returns matching records', async () => {
    const result = await handleMemory(memoryStore, projectId, {
      action: 'search',
      query: 'TypeScript',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(1);
    expect(parsed.records[0].content).toBe('Use TypeScript for all new code');

    const searchFn = memoryStore.search as ReturnType<typeof vi.fn>;
    expect(searchFn).toHaveBeenCalledWith('TypeScript', 'test-project');
  });

  it('search throws when query is missing', async () => {
    await expect(handleMemory(memoryStore, projectId, { action: 'search' })).rejects.toThrow(
      'query is required for search action',
    );
  });

  it('get returns record by ID', async () => {
    const result = await handleMemory(memoryStore, projectId, {
      action: 'get',
      memoryId: 1,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe(1);
    expect(parsed.content).toBe('Use TypeScript for all new code');

    const accessFn = memoryStore.recordAccess as ReturnType<typeof vi.fn>;
    expect(accessFn).toHaveBeenCalledWith(1);
  });

  it('get returns error for non-existent ID', async () => {
    const result = await handleMemory(memoryStore, projectId, {
      action: 'get',
      memoryId: 999,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('Not found');
  });

  it('get throws when memoryId is missing', async () => {
    await expect(handleMemory(memoryStore, projectId, { action: 'get' })).rejects.toThrow(
      'memoryId is required for get action',
    );
  });

  it('delete removes record', async () => {
    const result = await handleMemory(memoryStore, projectId, {
      action: 'delete',
      memoryId: 1,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.deleted).toBe(true);
    expect(parsed.memoryId).toBe(1);

    const deleteFn = memoryStore.delete as ReturnType<typeof vi.fn>;
    expect(deleteFn).toHaveBeenCalledWith(1);
  });

  it('delete throws when memoryId is missing', async () => {
    await expect(handleMemory(memoryStore, projectId, { action: 'delete' })).rejects.toThrow(
      'memoryId is required for delete action',
    );
  });

  it('throws ZodError when action is invalid', async () => {
    await expect(handleMemory(memoryStore, projectId, { action: 'unknown' })).rejects.toThrow(
      ZodError,
    );
  });

  it('throws ZodError when action is missing', async () => {
    await expect(handleMemory(memoryStore, projectId, {})).rejects.toThrow(ZodError);
  });
});

describe('handleCost', () => {
  let costStore: CostStore;

  beforeEach(() => {
    costStore = createMockCostStore();
  });

  it('session scope returns summary', async () => {
    const result = await handleCost(costStore, { scope: 'session', sessionId: 'sess-001' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].modelId).toBe('claude-sonnet-4-5-20250929');
    expect(parsed[0].totalCost).toBe(0.008);

    const summaryFn = costStore.getSessionSummary as ReturnType<typeof vi.fn>;
    expect(summaryFn).toHaveBeenCalledWith('sess-001');
  });

  it('session scope defaults sessionId to empty string', async () => {
    await handleCost(costStore, { scope: 'session' });

    const summaryFn = costStore.getSessionSummary as ReturnType<typeof vi.fn>;
    expect(summaryFn).toHaveBeenCalledWith('');
  });

  it('daily scope returns daily breakdown', async () => {
    const result = await handleCost(costStore, { scope: 'daily', days: 7 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].day).toBe('2026-02-10');

    const dailyFn = costStore.getDailySummary as ReturnType<typeof vi.fn>;
    expect(dailyFn).toHaveBeenCalledWith(7);
  });

  it('all scope calls getDailySummary with 365 days', async () => {
    await handleCost(costStore, { scope: 'all' });

    const dailyFn = costStore.getDailySummary as ReturnType<typeof vi.fn>;
    expect(dailyFn).toHaveBeenCalledWith(365);
  });

  it('defaults to session scope', async () => {
    await handleCost(costStore, {});

    const summaryFn = costStore.getSessionSummary as ReturnType<typeof vi.fn>;
    expect(summaryFn).toHaveBeenCalled();
  });

  it('throws ZodError for invalid scope', async () => {
    await expect(handleCost(costStore, { scope: 'weekly' })).rejects.toThrow(ZodError);
  });
});

describe('tool dispatch', () => {
  it('each handler is a callable function', () => {
    expect(typeof handleReview).toBe('function');
    expect(typeof handlePlan).toBe('function');
    expect(typeof handleDebate).toBe('function');
    expect(typeof handleMemory).toBe('function');
    expect(typeof handleCost).toBe('function');
  });

  it('review handler result has correct content structure', async () => {
    const orch = createMockOrchestrator();
    const result = await handleReview(orch, { content: 'test code' });

    expect(result.content[0].type).toBe('text');
    expect(typeof result.content[0].text).toBe('string');
    // Verify it is valid JSON
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });

  it('plan handler result has correct content structure', async () => {
    const orch = createMockOrchestrator();
    const result = await handlePlan(orch, { task: 'test task' });

    expect(result.content[0].type).toBe('text');
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });

  it('debate handler result has correct content structure', async () => {
    const orch = createMockOrchestrator();
    const result = await handleDebate(orch, {
      question: 'test?',
      models: ['a', 'b'],
    });

    expect(result.content[0].type).toBe('text');
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });

  it('memory handler result has correct content structure', async () => {
    const store = createMockMemoryStore();
    const result = await handleMemory(store, 'proj', {
      action: 'save',
      content: 'test',
    });

    expect(result.content[0].type).toBe('text');
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });

  it('cost handler result has correct content structure', async () => {
    const store = createMockCostStore();
    const result = await handleCost(store, { scope: 'daily' });

    expect(result.content[0].type).toBe('text');
    expect(() => JSON.parse(result.content[0].text)).not.toThrow();
  });
});

describe('Zod validation failures', () => {
  it('review: returns structured ZodError with path info', async () => {
    const orch = createMockOrchestrator();
    try {
      await handleReview(orch, { content: 123 });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      const zodErr = err as ZodError;
      expect(zodErr.issues.length).toBeGreaterThan(0);
      expect(zodErr.issues[0].path).toContain('content');
    }
  });

  it('plan: returns structured ZodError for invalid maxRounds type', async () => {
    const orch = createMockOrchestrator();
    try {
      await handlePlan(orch, { task: 'valid', maxRounds: 'not-a-number' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
    }
  });

  it('debate: returns structured ZodError for invalid question type', async () => {
    const orch = createMockOrchestrator();
    try {
      await handleDebate(orch, { question: 42 });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      const zodErr = err as ZodError;
      expect(zodErr.issues[0].path).toContain('question');
    }
  });

  it('memory: returns structured ZodError for invalid category', async () => {
    const store = createMockMemoryStore();
    try {
      await handleMemory(store, 'proj', {
        action: 'save',
        content: 'test',
        category: 'invalid-category',
      });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
    }
  });

  it('cost: returns structured ZodError for negative days', async () => {
    const store = createMockCostStore();
    try {
      await handleCost(store, { scope: 'daily', days: -5 });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
    }
  });
});
