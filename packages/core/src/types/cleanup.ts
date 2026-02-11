// packages/core/src/types/cleanup.ts — Cleanup scanner types

export type CleanupScope = 'deps' | 'unused-exports' | 'hardcoded' | 'duplicates' | 'deadcode' | 'security' | 'near-duplicates' | 'anti-patterns';

export type CleanupConfidence = 'high' | 'medium' | 'low';

/** Which analysis sources identified this finding */
export type CleanupSource = 'deterministic' | 'semantic' | 'host';

export interface CleanupFinding {
  /** Canonical key for merge matching: scope:normalizedPath:symbol */
  key: string;
  scope: CleanupScope;
  confidence: CleanupConfidence;
  file: string;
  line?: number;
  description: string;
  recommendation: string;
  /** Evidence from deterministic scanner */
  deterministicEvidence: string[];
  /** Evidence from semantic (codex) scanner */
  semanticEvidence: string[];
  /** Evidence from host AI (Claude) scanner */
  hostEvidence: string[];
  /** Which sources identified this finding */
  sources: CleanupSource[];
  /** Whether this finding was disputed between scanners */
  disputed: boolean;
  /** Group key for duplicate findings (sorted file:line pairs) */
  groupKey?: string;
  /** Package name for monorepo context */
  packageName?: string;
}

export interface CleanupReport {
  scopes: CleanupScope[];
  findings: CleanupFinding[];
  stats: {
    deterministic: number;
    semantic: number;
    host: number;
    agreed: number;
    disputed: number;
    adjudicated: number;
    highConfidence: number;
    mediumConfidence: number;
    lowConfidence: number;
  };
  durationMs: number;
}
