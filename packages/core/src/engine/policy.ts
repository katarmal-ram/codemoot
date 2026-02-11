// packages/core/src/engine/policy.ts — Minimal policy engine for commit gates

export type PolicyMode = 'warn' | 'enforce';
export type PolicyDecision = 'allow' | 'warn' | 'block';

export interface PolicyRule {
  id: string;
  when: string; // event name: 'review.completed', 'shipit.pre_commit'
  predicate: string; // built-in predicate name
  threshold?: number;
  action: 'warn' | 'block';
  message: string;
}

export interface PolicyContext {
  criticalCount: number;
  warningCount: number;
  verdict: string; // 'approved' | 'needs_revision' | 'unknown'
  stepsCompleted: Record<string, 'passed' | 'failed' | 'skipped'>;
  cleanupHighCount: number;
}

export interface PolicyResult {
  decision: PolicyDecision;
  violations: { ruleId: string; action: 'warn' | 'block'; message: string }[];
}

const BUILTIN_PREDICATES: Record<string, (ctx: PolicyContext, threshold?: number) => boolean> = {
  critical_findings_gt: (ctx, t) => ctx.criticalCount > (t ?? 0),
  warning_findings_gt: (ctx, t) => ctx.warningCount > (t ?? 0),
  verdict_is_needs_revision: (ctx) => ctx.verdict === 'needs_revision',
  step_failed: (ctx) => Object.values(ctx.stepsCompleted).includes('failed'),
  cleanup_high_gt: (ctx, t) => ctx.cleanupHighCount > (t ?? 0),
};

export const DEFAULT_RULES: PolicyRule[] = [
  {
    id: 'block-critical-review',
    when: 'review.completed',
    predicate: 'critical_findings_gt',
    threshold: 0,
    action: 'block',
    message: 'Critical findings must be fixed before commit.',
  },
  {
    id: 'warn-needs-revision',
    when: 'review.completed',
    predicate: 'verdict_is_needs_revision',
    action: 'warn',
    message: 'Review verdict is NEEDS_REVISION.',
  },
];

export function evaluatePolicy(
  event: string,
  context: PolicyContext,
  rules: PolicyRule[],
  mode: PolicyMode = 'enforce',
): PolicyResult {
  const violations: PolicyResult['violations'] = [];

  for (const rule of rules) {
    if (rule.when !== event) continue;

    const check = BUILTIN_PREDICATES[rule.predicate];
    if (!check) continue;

    if (check(context, rule.threshold)) {
      const action = mode === 'warn' ? 'warn' : rule.action;
      violations.push({ ruleId: rule.id, action, message: rule.message });
    }
  }

  const hasBlock = violations.some((v) => v.action === 'block');
  const hasWarn = violations.some((v) => v.action === 'warn');

  return {
    decision: hasBlock ? 'block' : hasWarn ? 'warn' : 'allow',
    violations,
  };
}
