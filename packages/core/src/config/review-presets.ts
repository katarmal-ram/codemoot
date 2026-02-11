// packages/core/src/config/review-presets.ts — Named review preset configurations

import { CLEANUP_TIMEOUT_SEC, MCP_TIMEOUT_MAX } from '../utils/constants.js';

export interface ReviewPreset {
  name: string;
  focus: string;
  constraints: string[];
  timeoutSec: number;
  severityFloor: 'info' | 'warning' | 'critical';
  strictOutput: boolean;
}

export const REVIEW_PRESETS: Record<string, ReviewPreset> = {
  'security-audit': {
    name: 'security-audit',
    focus: 'security',
    constraints: [
      'Prioritize exploitable paths and data flow.',
      'Map source-to-sink paths for injection, SSRF, deserialization.',
      'Flag missing rate limiting and audit logging.',
      'Check for secrets, hardcoded credentials, and unsafe dependencies.',
    ],
    timeoutSec: CLEANUP_TIMEOUT_SEC,
    severityFloor: 'info',
    strictOutput: true,
  },
  performance: {
    name: 'performance',
    focus: 'performance',
    constraints: [
      'Prefer measurable bottlenecks over speculative issues.',
      'Flag N+1 queries, unnecessary IO, memory churn, sync blocking.',
      'Suggest profiling points where relevant.',
    ],
    timeoutSec: MCP_TIMEOUT_MAX,
    severityFloor: 'warning',
    strictOutput: false,
  },
  'quick-scan': {
    name: 'quick-scan',
    focus: 'bugs',
    constraints: [
      'Return only top issues by impact.',
      'Skip speculative findings.',
      'Be concise — under 500 words.',
    ],
    timeoutSec: 240,
    severityFloor: 'warning',
    strictOutput: false,
  },
  'pre-commit': {
    name: 'pre-commit',
    focus: 'bugs',
    constraints: [
      'Only report CRITICAL and WARNING severity.',
      'Minimize false positives — err on the side of silence.',
      'Focus on changed code only.',
    ],
    timeoutSec: 180,
    severityFloor: 'warning',
    strictOutput: true,
  },
  'api-review': {
    name: 'api-review',
    focus: 'all',
    constraints: [
      'Check backward compatibility and schema drift.',
      'Validate status codes, error shapes, and pagination.',
      'Review auth boundaries and idempotency.',
    ],
    timeoutSec: MCP_TIMEOUT_MAX,
    severityFloor: 'info',
    strictOutput: false,
  },
};

export function getReviewPreset(name: string): ReviewPreset | undefined {
  return REVIEW_PRESETS[name];
}

export function listPresetNames(): string[] {
  return Object.keys(REVIEW_PRESETS);
}
