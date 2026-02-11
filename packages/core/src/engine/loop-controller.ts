// packages/core/src/engine/loop-controller.ts

import type { ResolvedStep } from '../types/workflow.js';
import type { EventBus } from './event-bus.js';
import type { StepResult, StepRunner } from './step-runner.js';

export interface LoopResult {
  finalOutput: string;
  iterations: number;
  approved: boolean;
  history: StepResult[];
}

export class LoopController {
  async executeLoop(
    generateStep: ResolvedStep,
    reviewStep: ResolvedStep,
    inputs: Map<string, string>,
    task: string,
    maxIterations: number,
    runner: StepRunner,
    eventBus: EventBus,
  ): Promise<LoopResult> {
    const history: StepResult[] = [];
    let currentInputs = new Map(inputs);
    let approved = false;

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      // Run generate step
      const generateResult = await runner.execute(generateStep, currentInputs, task, iteration);
      history.push(generateResult);

      // Build review inputs with the generated output
      const reviewInputs = new Map<string, string>();
      reviewInputs.set(generateStep.definition.id, generateResult.output);

      // Run review step
      const reviewResult = await runner.execute(reviewStep, reviewInputs, task, iteration);
      history.push(reviewResult);

      const verdict = reviewResult.verdict ?? 'needs_revision';

      // Emit loop.iteration event
      eventBus.emitEvent({
        type: 'loop.iteration',
        stepId: reviewStep.definition.id,
        iteration,
        maxIterations,
        verdict,
        feedback: reviewResult.feedback,
        timestamp: '',
      });

      if (verdict === 'approved') {
        approved = true;
        return {
          finalOutput: generateResult.output,
          iterations: iteration,
          approved,
          history,
        };
      }

      // If not approved and not at max, prepare inputs for next iteration
      if (iteration < maxIterations) {
        currentInputs = new Map<string, string>();
        currentInputs.set(generateStep.definition.id, generateResult.output);
        currentInputs.set('feedback', reviewResult.feedback ?? reviewResult.output);
      }
    }

    // Max iterations reached without approval
    const lastGenerateResult = history[history.length - 2];
    return {
      finalOutput: lastGenerateResult.output,
      iterations: maxIterations,
      approved: false,
      history,
    };
  }
}
