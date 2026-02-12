// packages/core/src/engine/step-runner.ts

import type { SessionStore } from '../memory/session-store.js';
import { callModel, streamModel } from '../models/caller.js';
import type { CostTracker } from '../models/cost-tracker.js';
import type { ModelRegistry } from '../models/registry.js';
import type { PromptType, PromptVariables } from '../roles/prompts.js';
import type { RoleManager } from '../roles/role-manager.js';
import type { ProjectConfig } from '../types/config.js';
import type { TokenUsage } from '../types/events.js';
import type { ModelCallResult } from '../types/models.js';
import type { ResolvedStep } from '../types/workflow.js';
import { parseVerdict } from '../utils/verdict.js';
import type { EventBus } from './event-bus.js';

export interface StepResult {
  stepId: string;
  output: string;
  usage: TokenUsage;
  durationMs: number;
  verdict?: 'approved' | 'needs_revision';
  feedback?: string;
  score?: number;
}

export class StepRunner {
  constructor(
    private registry: ModelRegistry,
    private roleManager: RoleManager,
    private costTracker: CostTracker,
    private eventBus: EventBus,
    private sessionStore: SessionStore,
    private config: ProjectConfig,
    private sessionId: string,
  ) {}

  async execute(
    step: ResolvedStep,
    inputs: Map<string, string>,
    task: string,
    iteration: number,
    options?: { stream?: boolean },
  ): Promise<StepResult> {
    const stepId = step.definition.id;
    const role = step.definition.role;
    const stepType = step.definition.type;

    // Determine prompt type
    const promptType = this.resolvePromptType(stepType, stepId, iteration);

    // Build prompt variables
    const promptVars = this.buildPromptVars(promptType, task, inputs, iteration);

    // Build messages
    const messages = this.roleManager.buildMessages(promptType, promptVars);

    // Get model for role
    const model = this.registry.getAdapterForRole(role, this.config);
    const modelConfig = this.registry.getModelConfigForRole(role, this.config);

    // Emit step.started
    this.eventBus.emitEvent({
      type: 'step.started',
      stepId,
      role,
      model: modelConfig.model,
      iteration,
      timestamp: '',
    });

    const start = Date.now();
    let result: ModelCallResult;

    if (options?.stream) {
      result = await this.costTracker.tracked(
        () =>
          streamModel(
            model,
            messages,
            (delta) => {
              this.eventBus.emitEvent({
                type: 'text.delta',
                stepId,
                role,
                delta,
              });
            },
            stepId,
            role,
          ),
        stepId,
      );

      this.eventBus.emitEvent({
        type: 'text.done',
        stepId,
        role,
        fullText: result.text,
      });
    } else {
      result = await this.costTracker.tracked(() => callModel(model, messages), stepId);
    }

    const durationMs = Date.now() - start;

    // Save transcript entry
    this.sessionStore.saveTranscriptEntry({
      sessionId: this.sessionId,
      stepId,
      iteration,
      role,
      modelId: result.model,
      content: result.text,
      tokenCount: result.usage.totalTokens,
      cost: result.usage.costUsd,
      createdAt: new Date().toISOString(),
      metadata: null,
    });

    // Parse verdict and score for review steps
    let verdict: 'approved' | 'needs_revision' | undefined;
    let feedback: string | undefined;
    let score: number | undefined;
    if (stepType === 'review') {
      const parsed = parseVerdict(result.text);
      verdict = parsed.verdict;
      feedback = parsed.feedback || undefined;
      const scoreMatch = result.text.slice(-500).match(/SCORE:\s*(\d+)\/10/);
      if (scoreMatch) {
        score = Number.parseInt(scoreMatch[1], 10);
      }
    }

    // Emit step.completed
    this.eventBus.emitEvent({
      type: 'step.completed',
      stepId,
      output: result.text,
      tokenUsage: result.usage,
      durationMs,
      timestamp: '',
    });

    return {
      stepId,
      output: result.text,
      usage: result.usage,
      durationMs,
      verdict,
      feedback,
      score,
    };
  }

  private resolvePromptType(stepType: string, stepId: string, iteration: number): PromptType {
    if (stepType === 'generate') {
      if (iteration > 1) {
        return stepId.includes('implement') ? 'code' : 'plan-revision';
      }
      if (stepId.includes('plan')) return 'plan';
      if (stepId.includes('implement')) return 'code';
      return 'plan';
    }
    if (stepType === 'review') {
      return stepId.includes('code') ? 'code-review' : 'plan-review';
    }
    // Fallback for other step types
    return 'plan';
  }

  private buildPromptVars(
    promptType: PromptType,
    task: string,
    inputs: Map<string, string>,
    _iteration: number,
  ): PromptVariables {
    const vars: PromptVariables = { task };

    // Get the first input value as the primary content
    const inputValues = [...inputs.values()];
    const primaryInput = inputValues[0] ?? '';

    switch (promptType) {
      case 'plan':
        break;
      case 'plan-review':
        vars.plan = primaryInput;
        break;
      case 'plan-revision':
        vars.previousPlan = primaryInput;
        vars.feedback = inputValues[1] ?? '';
        break;
      case 'code':
        vars.plan = primaryInput;
        break;
      case 'code-review':
        vars.plan = primaryInput;
        vars.code = inputValues[1] ?? '';
        break;
    }

    return vars;
  }
}
