import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../src/engine/event-bus.js';
import { StepRunner } from '../../../src/engine/step-runner.js';
import type { ProjectConfig } from '../../../src/types/config.js';
import type { EngineEvent } from '../../../src/types/events.js';
import type { ResolvedStep } from '../../../src/types/workflow.js';

// Mock caller module
vi.mock('../../../src/models/caller.js', () => ({
  callModel: vi.fn(async () => ({
    text: 'Generated plan output',
    model: 'gpt-5.3-codex',
    provider: 'openai',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costUsd: 0.001,
    },
    finishReason: 'stop',
    durationMs: 200,
  })),
  streamModel: vi.fn(async (_model: unknown, _msgs: unknown, onDelta: (d: string) => void) => {
    onDelta('Hello');
    onDelta(' world');
    return {
      text: 'Hello world',
      model: 'gpt-5.3-codex',
      provider: 'openai',
      usage: {
        inputTokens: 80,
        outputTokens: 30,
        totalTokens: 110,
        costUsd: 0.0008,
      },
      finishReason: 'stop',
      durationMs: 150,
    };
  }),
}));

const mockModel = { modelId: 'gpt-5.3-codex', provider: 'openai' } as never;

const mockModelConfig = {
  provider: 'openai' as const,
  model: 'gpt-5.3-codex',
  maxTokens: 4096,
  temperature: 0.7,
  timeout: 30000,
};

const mockRegistry = {
  getModelForRole: vi.fn(() => mockModel),
  getAdapterForRole: vi.fn(() => mockModel),
  getModelConfigForRole: vi.fn(() => mockModelConfig),
};

const mockRoleManager = {
  buildMessages: vi.fn(() => [
    { role: 'system' as const, content: 'You are an architect.' },
    { role: 'user' as const, content: 'Build a feature.' },
  ]),
};

const mockCostTracker = {
  tracked: vi.fn(async (fn: () => Promise<unknown>) => fn()),
};

const mockSessionStore = {
  saveTranscriptEntry: vi.fn(),
};

const mockConfig = {
  project: { name: 'TestProject', description: 'Test' },
  roles: { architect: { model: 'codex-architect' } },
} as unknown as ProjectConfig;

function makeStep(overrides: Partial<ResolvedStep['definition']> = {}): ResolvedStep {
  return {
    definition: {
      id: 'plan',
      type: 'generate',
      role: 'architect',
      ...overrides,
    },
    inputStepIds: [],
    isLoopEntry: false,
  };
}

function createRunner(eventBus: EventBus): StepRunner {
  return new StepRunner(
    mockRegistry as never,
    mockRoleManager as never,
    mockCostTracker as never,
    eventBus,
    mockSessionStore as never,
    mockConfig,
    'sess-001',
  );
}

describe('StepRunner', () => {
  it('executes a generate step and returns correct result shape', async () => {
    const eventBus = new EventBus();
    const runner = createRunner(eventBus);
    const step = makeStep({ id: 'plan', type: 'generate' });
    const inputs = new Map<string, string>();

    const result = await runner.execute(step, inputs, 'Build user auth', 1);

    expect(result.stepId).toBe('plan');
    expect(result.output).toBe('Generated plan output');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.verdict).toBeUndefined();
    expect(result.feedback).toBeUndefined();
  });

  it('assembles correct messages via roleManager.buildMessages', async () => {
    const eventBus = new EventBus();
    const runner = createRunner(eventBus);
    const step = makeStep({ id: 'plan', type: 'generate' });

    await runner.execute(step, new Map(), 'Build auth', 1);

    expect(mockRoleManager.buildMessages).toHaveBeenCalledWith(
      'plan',
      expect.objectContaining({ task: 'Build auth' }),
    );
  });

  it('calls model via callModel in non-streaming mode', async () => {
    const { callModel } = await import('../../../src/models/caller.js');
    const eventBus = new EventBus();
    const runner = createRunner(eventBus);
    const step = makeStep();

    await runner.execute(step, new Map(), 'task', 1);

    expect(callModel).toHaveBeenCalled();
  });

  it('executes a review step and parses verdict', async () => {
    const { callModel } = await import('../../../src/models/caller.js');
    (callModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'Looks good overall.\n\nVERDICT: APPROVED',
      model: 'gpt-5',
      provider: 'openai',
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 0.002 },
      finishReason: 'stop',
      durationMs: 300,
    });

    const eventBus = new EventBus();
    const runner = createRunner(eventBus);
    const step = makeStep({ id: 'review-plan', type: 'review', role: 'reviewer' });
    const inputs = new Map([['plan', 'The plan content']]);

    const result = await runner.execute(step, inputs, 'Build auth', 1);

    expect(result.verdict).toBe('approved');
    expect(result.feedback).toBeUndefined();
  });

  it('extracts feedback from needs_revision verdict', async () => {
    const { callModel } = await import('../../../src/models/caller.js');
    (callModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'Missing error handling in auth module.\n\nVERDICT: NEEDS_REVISION',
      model: 'gpt-5',
      provider: 'openai',
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 0.002 },
      finishReason: 'stop',
      durationMs: 300,
    });

    const eventBus = new EventBus();
    const runner = createRunner(eventBus);
    const step = makeStep({ id: 'review-plan', type: 'review', role: 'reviewer' });

    const result = await runner.execute(step, new Map([['plan', 'plan']]), 'task', 1);

    expect(result.verdict).toBe('needs_revision');
    expect(result.feedback).toBe('Missing error handling in auth module.');
  });

  it('emits text.delta events in streaming mode', async () => {
    const eventBus = new EventBus();
    const events: EngineEvent[] = [];
    eventBus.on('event', (e) => events.push(e));

    const runner = createRunner(eventBus);
    const step = makeStep();

    await runner.execute(step, new Map(), 'task', 1, { stream: true });

    const deltas = events.filter((e) => e.type === 'text.delta');
    expect(deltas).toHaveLength(2);
    expect((deltas[0] as { delta: string }).delta).toBe('Hello');
    expect((deltas[1] as { delta: string }).delta).toBe(' world');

    const doneEvents = events.filter((e) => e.type === 'text.done');
    expect(doneEvents).toHaveLength(1);
  });

  it('emits step.started and step.completed events', async () => {
    const eventBus = new EventBus();
    const events: EngineEvent[] = [];
    eventBus.on('event', (e) => events.push(e));

    const runner = createRunner(eventBus);
    const step = makeStep({ id: 'plan' });

    await runner.execute(step, new Map(), 'task', 1);

    const started = events.find((e) => e.type === 'step.started');
    const completed = events.find((e) => e.type === 'step.completed');

    expect(started).toBeDefined();
    expect((started as { stepId: string }).stepId).toBe('plan');
    expect((started as { role: string }).role).toBe('architect');
    expect((started as { iteration: number }).iteration).toBe(1);

    expect(completed).toBeDefined();
    expect((completed as { stepId: string }).stepId).toBe('plan');
    expect((completed as { output: string }).output).toBe('Generated plan output');
  });

  it('saves transcript entry to session store', async () => {
    const eventBus = new EventBus();
    const runner = createRunner(eventBus);
    const step = makeStep();

    await runner.execute(step, new Map(), 'task', 1);

    expect(mockSessionStore.saveTranscriptEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-001',
        stepId: 'plan',
        iteration: 1,
        role: 'architect',
        content: 'Generated plan output',
      }),
    );
  });

  it('tracks cost via costTracker.tracked', async () => {
    const eventBus = new EventBus();
    const runner = createRunner(eventBus);
    const step = makeStep();

    await runner.execute(step, new Map(), 'task', 1);

    expect(mockCostTracker.tracked).toHaveBeenCalledWith(expect.any(Function), 'plan');
  });

  it('resolves plan-revision prompt type on iteration > 1', async () => {
    const eventBus = new EventBus();
    const runner = createRunner(eventBus);
    const step = makeStep({ id: 'plan', type: 'generate' });
    const inputs = new Map([
      ['plan', 'previous plan'],
      ['feedback', 'fix bugs'],
    ]);

    await runner.execute(step, inputs, 'task', 2);

    expect(mockRoleManager.buildMessages).toHaveBeenCalledWith(
      'plan-revision',
      expect.objectContaining({ task: 'task' }),
    );
  });

  it('resolves code prompt type for implement step id', async () => {
    const eventBus = new EventBus();
    const runner = createRunner(eventBus);
    const step = makeStep({ id: 'implement-code', type: 'generate', role: 'implementer' });

    await runner.execute(step, new Map([['plan', 'approved plan']]), 'task', 1);

    expect(mockRoleManager.buildMessages).toHaveBeenCalledWith(
      'code',
      expect.objectContaining({ task: 'task' }),
    );
  });

  it('resolves code-review prompt for code review step', async () => {
    const { callModel } = await import('../../../src/models/caller.js');
    (callModel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: 'VERDICT: APPROVED',
      model: 'gpt-5',
      provider: 'openai',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 },
      finishReason: 'stop',
      durationMs: 100,
    });

    const eventBus = new EventBus();
    const runner = createRunner(eventBus);
    const step = makeStep({ id: 'code-review', type: 'review', role: 'reviewer' });

    await runner.execute(
      step,
      new Map([
        ['plan', 'plan'],
        ['code', 'function foo() {}'],
      ]),
      'task',
      1,
    );

    expect(mockRoleManager.buildMessages).toHaveBeenCalledWith(
      'code-review',
      expect.objectContaining({ task: 'task' }),
    );
  });
});
