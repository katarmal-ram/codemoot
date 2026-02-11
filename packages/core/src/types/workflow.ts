// packages/core/src/types/workflow.ts

/**
 * A workflow is a DAG of steps loaded from YAML.
 * Sprint 1 supports: generate, review. Other types are parsed but not executed.
 */
export interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: StepDefinition[];
}

export interface StepDefinition {
  id: string;
  type: StepType;
  role: string;
  input?: string[];
  output?: string;
  loop?: LoopConfig;

  // Only for type: 'parallel' (Sprint 2)
  steps?: StepDefinition[];
  // Only for type: 'transform' (Sprint 2)
  command?: string;
  // Only for type: 'gate' (Sprint 2)
  gateMode?: 'always' | 'conditional';
}

export type StepType =
  | 'generate'
  | 'review'
  | 'debate'
  | 'transform'
  | 'gate'
  | 'parallel'
  | 'conditional';

export interface LoopConfig {
  maxIterations: number;
  exitWhen: string;
  iteratesWith: string;
}

/**
 * Validated workflow: steps resolved into execution order.
 * The engine works with this, not the raw definition.
 */
export interface ResolvedWorkflow {
  name: string;
  executionOrder: ResolvedStep[];
}

export interface ResolvedStep {
  definition: StepDefinition;
  inputStepIds: string[];
  isLoopEntry: boolean;
  loopPartnerStepId?: string;
}
