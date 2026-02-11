// packages/core/src/engine/workflow-engine.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  ResolvedStep,
  ResolvedWorkflow,
  StepDefinition,
  WorkflowDefinition,
} from '../types/workflow.js';
import { WorkflowError } from '../utils/errors.js';

const VALID_STEP_TYPES: Set<string> = new Set<string>([
  'generate',
  'review',
  'debate',
  'transform',
  'gate',
  'parallel',
  'conditional',
]);

/**
 * Loads workflow YAML files, validates them, and resolves step dependencies
 * into a topologically sorted execution order.
 */
export class WorkflowEngine {
  constructor(private workflowDir: string) {}

  /**
   * Load a workflow YAML file by name, validate it, and resolve into a DAG.
   */
  load(workflowName: string): ResolvedWorkflow {
    const filePath = join(this.workflowDir, `${workflowName}.yml`);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      throw new WorkflowError(`Workflow file not found: ${filePath}`);
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      throw new WorkflowError(`Invalid YAML in workflow: ${workflowName}`);
    }

    const definition = parsed as WorkflowDefinition;
    this.validateDefinition(definition, workflowName);

    const executionOrder = this.resolveSteps(definition.steps);

    return {
      name: definition.name,
      executionOrder,
    };
  }

  /**
   * Returns the topologically sorted steps (already computed during load).
   */
  getExecutionOrder(workflow: ResolvedWorkflow): ResolvedStep[] {
    return workflow.executionOrder;
  }

  private validateDefinition(def: WorkflowDefinition, workflowName: string): void {
    if (!def || typeof def !== 'object') {
      throw new WorkflowError(`Workflow "${workflowName}" is not a valid object`);
    }
    if (!def.name || typeof def.name !== 'string') {
      throw new WorkflowError(`Workflow "${workflowName}" is missing a name`);
    }
    if (!Array.isArray(def.steps) || def.steps.length === 0) {
      throw new WorkflowError(`Workflow "${workflowName}" has no steps`);
    }

    const stepIds = new Set<string>();
    for (const step of def.steps) {
      this.validateStep(step, stepIds, workflowName);
      stepIds.add(step.id);
    }
  }

  private validateStep(step: StepDefinition, knownIds: Set<string>, workflowName: string): void {
    if (!step.id || typeof step.id !== 'string') {
      throw new WorkflowError(`Step in "${workflowName}" is missing an id`);
    }
    if (knownIds.has(step.id)) {
      throw new WorkflowError(`Duplicate step id "${step.id}" in "${workflowName}"`, step.id);
    }
    if (!step.type || !VALID_STEP_TYPES.has(step.type)) {
      throw new WorkflowError(`Step "${step.id}" has invalid type "${step.type}"`, step.id);
    }
    if (!step.role || typeof step.role !== 'string') {
      throw new WorkflowError(`Step "${step.id}" is missing a role`, step.id);
    }
  }

  /**
   * Resolve steps into topological order, validating input references and loops.
   */
  private resolveSteps(steps: StepDefinition[]): ResolvedStep[] {
    const stepMap = new Map<string, StepDefinition>();
    const outputMap = new Map<string, string>(); // output ref -> step id

    for (const step of steps) {
      stepMap.set(step.id, step);
      if (step.output) {
        outputMap.set(step.output, step.id);
      }
    }

    // Build adjacency for topological sort: edges[stepId] = set of dependency step ids
    const edges = new Map<string, Set<string>>();
    for (const step of steps) {
      const deps = new Set<string>();

      if (step.input) {
        for (const ref of step.input) {
          const sourceStepId = outputMap.get(ref);
          if (sourceStepId === undefined) {
            throw new WorkflowError(`Step "${step.id}" references unknown input "${ref}"`, step.id);
          }
          deps.add(sourceStepId);
        }
      }

      if (step.loop) {
        if (!stepMap.has(step.loop.iteratesWith)) {
          throw new WorkflowError(
            `Step "${step.id}" loop references unknown step "${step.loop.iteratesWith}"`,
            step.id,
          );
        }
      }

      edges.set(step.id, deps);
    }

    // Topological sort (Kahn's algorithm)
    const inDegree = new Map<string, number>();
    for (const step of steps) {
      inDegree.set(step.id, 0);
    }
    for (const [, deps] of edges) {
      for (const dep of deps) {
        inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
      }
    }

    // Kahn's: nodes with no incoming edges start the queue
    // But inDegree here tracks how many nodes depend ON each node.
    // We need it the other way: how many dependencies does each node have.
    const depCount = new Map<string, number>();
    for (const [stepId, deps] of edges) {
      depCount.set(stepId, deps.size);
    }

    const queue: string[] = [];
    for (const [stepId, count] of depCount) {
      if (count === 0) {
        queue.push(stepId);
      }
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      sorted.push(current);

      // Find all steps that depend on current
      for (const [stepId, deps] of edges) {
        if (deps.has(current)) {
          const newCount = (depCount.get(stepId) ?? 0) - 1;
          depCount.set(stepId, newCount);
          if (newCount === 0) {
            queue.push(stepId);
          }
        }
      }
    }

    if (sorted.length !== steps.length) {
      throw new WorkflowError('Workflow contains a cycle');
    }

    // Build resolved steps
    return sorted.map((stepId) => {
      const def = stepMap.get(stepId) as StepDefinition;
      const deps = edges.get(stepId) as Set<string>;

      return {
        definition: def,
        inputStepIds: [...deps],
        isLoopEntry: def.loop !== undefined,
        loopPartnerStepId: def.loop?.iteratesWith,
      };
    });
  }
}
