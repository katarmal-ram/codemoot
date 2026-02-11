import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../../src/engine/event-bus.js';
import { LoopController } from '../../../src/engine/loop-controller.js';
import type { StepResult } from '../../../src/engine/step-runner.js';
import type { EngineEvent } from '../../../src/types/events.js';
import type { ResolvedStep } from '../../../src/types/workflow.js';

const generateStep: ResolvedStep = {
  definition: { id: 'plan', type: 'generate', role: 'architect' },
  inputStepIds: [],
  isLoopEntry: true,
  loopPartnerStepId: 'review-plan',
};

const reviewStep: ResolvedStep = {
  definition: { id: 'review-plan', type: 'review', role: 'reviewer' },
  inputStepIds: ['plan'],
  isLoopEntry: false,
  loopPartnerStepId: 'plan',
};

function makeGenerateResult(iteration: number): StepResult {
  return {
    stepId: 'plan',
    output: `Plan v${iteration}`,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 },
    durationMs: 200,
  };
}

function makeReviewResult(verdict: 'approved' | 'needs_revision', feedback?: string): StepResult {
  return {
    stepId: 'review-plan',
    output: verdict === 'approved' ? 'VERDICT: APPROVED' : `${feedback}\n\nVERDICT: NEEDS_REVISION`,
    usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 0.002 },
    durationMs: 300,
    verdict,
    feedback,
  };
}

describe('LoopController', () => {
  it('returns approved on first iteration', async () => {
    const eventBus = new EventBus();
    const controller = new LoopController();

    let callCount = 0;
    const mockRunner = {
      execute: vi.fn(async () => {
        callCount++;
        if (callCount === 1) return makeGenerateResult(1);
        return makeReviewResult('approved');
      }),
    };

    const result = await controller.executeLoop(
      generateStep,
      reviewStep,
      new Map(),
      'Build auth',
      3,
      mockRunner as never,
      eventBus,
    );

    expect(result.approved).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.finalOutput).toBe('Plan v1');
    expect(result.history).toHaveLength(2);
    expect(mockRunner.execute).toHaveBeenCalledTimes(2);
  });

  it('iterates until approved on 3rd iteration', async () => {
    const eventBus = new EventBus();
    const controller = new LoopController();

    let callCount = 0;
    const mockRunner = {
      execute: vi.fn(async () => {
        callCount++;
        // Calls: gen1, rev1, gen2, rev2, gen3, rev3
        if (callCount % 2 === 1) return makeGenerateResult(Math.ceil(callCount / 2));
        if (callCount < 6) return makeReviewResult('needs_revision', 'Fix issues');
        return makeReviewResult('approved');
      }),
    };

    const result = await controller.executeLoop(
      generateStep,
      reviewStep,
      new Map(),
      'task',
      5,
      mockRunner as never,
      eventBus,
    );

    expect(result.approved).toBe(true);
    expect(result.iterations).toBe(3);
    expect(result.finalOutput).toBe('Plan v3');
    expect(result.history).toHaveLength(6);
  });

  it('returns approved=false when max iterations reached', async () => {
    const eventBus = new EventBus();
    const controller = new LoopController();

    let callCount = 0;
    const mockRunner = {
      execute: vi.fn(async () => {
        callCount++;
        if (callCount % 2 === 1) return makeGenerateResult(Math.ceil(callCount / 2));
        return makeReviewResult('needs_revision', 'Still needs work');
      }),
    };

    const result = await controller.executeLoop(
      generateStep,
      reviewStep,
      new Map(),
      'task',
      2,
      mockRunner as never,
      eventBus,
    );

    expect(result.approved).toBe(false);
    expect(result.iterations).toBe(2);
    expect(result.history).toHaveLength(4);
  });

  it('emits loop.iteration events with correct data', async () => {
    const eventBus = new EventBus();
    const events: EngineEvent[] = [];
    eventBus.on('event', (e) => events.push(e));

    const controller = new LoopController();

    let callCount = 0;
    const mockRunner = {
      execute: vi.fn(async () => {
        callCount++;
        if (callCount % 2 === 1) return makeGenerateResult(Math.ceil(callCount / 2));
        if (callCount < 4) return makeReviewResult('needs_revision', 'Fix issues');
        return makeReviewResult('approved');
      }),
    };

    await controller.executeLoop(
      generateStep,
      reviewStep,
      new Map(),
      'task',
      3,
      mockRunner as never,
      eventBus,
    );

    const loopEvents = events.filter((e) => e.type === 'loop.iteration');
    expect(loopEvents).toHaveLength(2);

    const first = loopEvents[0] as { iteration: number; verdict: string; feedback?: string };
    expect(first.iteration).toBe(1);
    expect(first.verdict).toBe('needs_revision');
    expect(first.feedback).toBe('Fix issues');

    const second = loopEvents[1] as { iteration: number; verdict: string };
    expect(second.iteration).toBe(2);
    expect(second.verdict).toBe('approved');
  });

  it('history contains all step results in order', async () => {
    const eventBus = new EventBus();
    const controller = new LoopController();

    let callCount = 0;
    const mockRunner = {
      execute: vi.fn(async () => {
        callCount++;
        if (callCount === 1) return makeGenerateResult(1);
        return makeReviewResult('approved');
      }),
    };

    const result = await controller.executeLoop(
      generateStep,
      reviewStep,
      new Map(),
      'task',
      3,
      mockRunner as never,
      eventBus,
    );

    expect(result.history[0].stepId).toBe('plan');
    expect(result.history[1].stepId).toBe('review-plan');
  });

  it('passes feedback from review to next generate iteration', async () => {
    const eventBus = new EventBus();
    const controller = new LoopController();

    let callCount = 0;
    const mockRunner = {
      execute: vi.fn(
        async (
          step: ResolvedStep,
          inputs: Map<string, string>,
          _task: string,
          iteration: number,
        ) => {
          callCount++;
          if (callCount % 2 === 1) {
            // Generate step
            if (iteration > 1) {
              // On subsequent iterations, verify feedback is in inputs
              expect(inputs.has('feedback')).toBe(true);
            }
            return makeGenerateResult(iteration);
          }
          if (callCount < 4) return makeReviewResult('needs_revision', 'Add error handling');
          return makeReviewResult('approved');
        },
      ),
    };

    const result = await controller.executeLoop(
      generateStep,
      reviewStep,
      new Map(),
      'task',
      3,
      mockRunner as never,
      eventBus,
    );

    expect(result.approved).toBe(true);
    expect(result.iterations).toBe(2);
  });
});
