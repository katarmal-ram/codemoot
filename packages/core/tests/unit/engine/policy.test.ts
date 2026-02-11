import { describe, expect, it } from 'vitest';
import { evaluatePolicy, DEFAULT_RULES, type PolicyContext } from '../../../src/engine/policy.js';

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    criticalCount: 0,
    warningCount: 0,
    verdict: 'approved',
    stepsCompleted: {},
    cleanupHighCount: 0,
    ...overrides,
  };
}

describe('evaluatePolicy', () => {
  it('allows when no violations', () => {
    const result = evaluatePolicy('review.completed', makeCtx(), DEFAULT_RULES);
    expect(result.decision).toBe('allow');
    expect(result.violations).toHaveLength(0);
  });

  it('blocks on critical findings', () => {
    const result = evaluatePolicy('review.completed', makeCtx({ criticalCount: 2 }), DEFAULT_RULES);
    expect(result.decision).toBe('block');
    expect(result.violations.some(v => v.ruleId === 'block-critical-review')).toBe(true);
  });

  it('warns on needs_revision verdict', () => {
    const result = evaluatePolicy('review.completed', makeCtx({ verdict: 'needs_revision' }), DEFAULT_RULES);
    expect(result.decision).toBe('warn');
    expect(result.violations.some(v => v.ruleId === 'warn-needs-revision')).toBe(true);
  });

  it('block + warn = block', () => {
    const result = evaluatePolicy('review.completed', makeCtx({ criticalCount: 1, verdict: 'needs_revision' }), DEFAULT_RULES);
    expect(result.decision).toBe('block');
    expect(result.violations).toHaveLength(2);
  });

  it('ignores rules for non-matching events', () => {
    const result = evaluatePolicy('shipit.pre_commit', makeCtx({ criticalCount: 5 }), DEFAULT_RULES);
    expect(result.decision).toBe('allow');
  });

  it('warn mode downgrades block to warn', () => {
    const result = evaluatePolicy('review.completed', makeCtx({ criticalCount: 1 }), DEFAULT_RULES, 'warn');
    expect(result.decision).toBe('warn');
  });

  it('custom rule with step_failed', () => {
    const rules = [{ id: 'fail-gate', when: 'shipit.pre_commit', predicate: 'step_failed', action: 'block' as const, message: 'A step failed.' }];
    const ctx = makeCtx({ stepsCompleted: { lint: 'passed', test: 'failed' } });
    const result = evaluatePolicy('shipit.pre_commit', ctx, rules);
    expect(result.decision).toBe('block');
  });

  it('unknown predicate is skipped', () => {
    const rules = [{ id: 'bad', when: 'review.completed', predicate: 'nonexistent', action: 'block' as const, message: 'x' }];
    const result = evaluatePolicy('review.completed', makeCtx({ criticalCount: 5 }), rules);
    expect(result.decision).toBe('allow');
  });
});
