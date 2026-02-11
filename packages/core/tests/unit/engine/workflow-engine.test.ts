import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../../../src/engine/workflow-engine.js';

/** Path to the real workflows directory at the monorepo root. */
const WORKFLOWS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'workflows');

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine(WORKFLOWS_DIR);
  });

  it('loads the default plan-review-implement workflow', () => {
    const workflow = engine.load('plan-review-implement');
    expect(workflow.name).toBe('plan-review-implement');
  });

  it('resolves the correct step count', () => {
    const workflow = engine.load('plan-review-implement');
    expect(workflow.executionOrder).toHaveLength(4);
  });

  it('resolves correct execution order', () => {
    const workflow = engine.load('plan-review-implement');
    const order = engine.getExecutionOrder(workflow);
    const ids = order.map((s) => s.definition.id);

    expect(ids).toEqual(['plan', 'review-plan', 'implement', 'code-review']);
  });

  it('identifies loop entries with correct partners', () => {
    const workflow = engine.load('plan-review-implement');
    const order = engine.getExecutionOrder(workflow);

    const reviewPlan = order.find((s) => s.definition.id === 'review-plan');
    expect(reviewPlan?.isLoopEntry).toBe(true);
    expect(reviewPlan?.loopPartnerStepId).toBe('plan');

    const codeReview = order.find((s) => s.definition.id === 'code-review');
    expect(codeReview?.isLoopEntry).toBe(true);
    expect(codeReview?.loopPartnerStepId).toBe('implement');
  });

  it('resolves input references correctly', () => {
    const workflow = engine.load('plan-review-implement');
    const order = engine.getExecutionOrder(workflow);

    const reviewPlan = order.find((s) => s.definition.id === 'review-plan');
    expect(reviewPlan?.inputStepIds).toEqual(['plan']);

    const implement = order.find((s) => s.definition.id === 'implement');
    expect(implement?.inputStepIds).toEqual(['plan']);

    const codeReview = order.find((s) => s.definition.id === 'code-review');
    expect(codeReview?.inputStepIds).toEqual(['implement']);
  });

  it('marks non-loop steps correctly', () => {
    const workflow = engine.load('plan-review-implement');
    const order = engine.getExecutionOrder(workflow);

    const plan = order.find((s) => s.definition.id === 'plan');
    expect(plan?.isLoopEntry).toBe(false);
    expect(plan?.loopPartnerStepId).toBeUndefined();

    const implement = order.find((s) => s.definition.id === 'implement');
    expect(implement?.isLoopEntry).toBe(false);
  });

  describe('validation errors', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `codemoot-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    it('throws WorkflowError for invalid YAML', () => {
      writeFileSync(join(tmpDir, 'bad.yml'), '{{invalid: yaml: content}}', 'utf-8');
      const badEngine = new WorkflowEngine(tmpDir);

      expect(() => badEngine.load('bad')).toThrow('Invalid YAML');
    });

    it('throws WorkflowError for missing file', () => {
      const badEngine = new WorkflowEngine(tmpDir);
      expect(() => badEngine.load('nonexistent')).toThrow('not found');
    });

    it('throws WorkflowError for missing step reference', () => {
      const yaml = [
        'name: bad-ref',
        'steps:',
        '  - id: step1',
        '    type: generate',
        '    role: architect',
        '    input: [nonexistent.output]',
      ].join('\n');
      writeFileSync(join(tmpDir, 'bad-ref.yml'), yaml, 'utf-8');
      const badEngine = new WorkflowEngine(tmpDir);

      expect(() => badEngine.load('bad-ref')).toThrow('unknown input');
    });

    it('throws WorkflowError for empty steps', () => {
      const yaml = ['name: empty', 'steps: []'].join('\n');
      writeFileSync(join(tmpDir, 'empty.yml'), yaml, 'utf-8');
      const badEngine = new WorkflowEngine(tmpDir);

      expect(() => badEngine.load('empty')).toThrow('no steps');
    });

    it('throws WorkflowError for duplicate step ids', () => {
      const yaml = [
        'name: dup',
        'steps:',
        '  - id: step1',
        '    type: generate',
        '    role: architect',
        '  - id: step1',
        '    type: review',
        '    role: reviewer',
      ].join('\n');
      writeFileSync(join(tmpDir, 'dup.yml'), yaml, 'utf-8');
      const badEngine = new WorkflowEngine(tmpDir);

      expect(() => badEngine.load('dup')).toThrow('Duplicate step id');
    });

    it('throws WorkflowError for invalid step type', () => {
      const yaml = [
        'name: bad-type',
        'steps:',
        '  - id: step1',
        '    type: invalid_type',
        '    role: architect',
      ].join('\n');
      writeFileSync(join(tmpDir, 'bad-type.yml'), yaml, 'utf-8');
      const badEngine = new WorkflowEngine(tmpDir);

      expect(() => badEngine.load('bad-type')).toThrow('invalid type');
    });

    it('throws WorkflowError for invalid loop reference', () => {
      const yaml = [
        'name: bad-loop',
        'steps:',
        '  - id: step1',
        '    type: review',
        '    role: reviewer',
        '    loop:',
        '      maxIterations: 3',
        '      exitWhen: "done"',
        '      iteratesWith: nonexistent',
      ].join('\n');
      writeFileSync(join(tmpDir, 'bad-loop.yml'), yaml, 'utf-8');
      const badEngine = new WorkflowEngine(tmpDir);

      expect(() => badEngine.load('bad-loop')).toThrow('unknown step');
    });
  });
});
