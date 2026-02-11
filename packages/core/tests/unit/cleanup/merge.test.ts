import { describe, expect, it } from 'vitest';
import type { CleanupFinding } from '../../../src/types/cleanup.js';
import {
  mergeThreeWay,
  mergeTwoWay,
  computeThreeWayStats,
  computeTwoWayStats,
  recalculateConfidenceStats,
} from '../../../src/cleanup/merge.js';

function makeFinding(overrides: Partial<CleanupFinding> & { key: string }): CleanupFinding {
  return {
    scope: 'deps',
    confidence: 'medium',
    file: 'src/index.ts',
    description: 'test finding',
    recommendation: 'fix it',
    deterministicEvidence: [],
    semanticEvidence: [],
    hostEvidence: [],
    sources: [],
    disputed: false,
    ...overrides,
  };
}

describe('mergeThreeWay', () => {
  it('boosts confidence when all 3 sources agree', () => {
    const det = [makeFinding({ key: 'deps:pkg.json:lodash', deterministicEvidence: ['unused'], sources: ['deterministic'] })];
    const sem = [makeFinding({ key: 'deps:pkg.json:lodash', semanticEvidence: ['codex: unused'], sources: ['semantic'] })];
    const host = [makeFinding({ key: 'deps:pkg.json:lodash', hostEvidence: ['host: unused'], sources: ['host'] })];

    const merged = mergeThreeWay(det, sem, host);

    expect(merged).toHaveLength(1);
    expect(merged[0].confidence).toBe('high');
    expect(merged[0].sources).toEqual(['deterministic', 'semantic', 'host']);
    expect(merged[0].disputed).toBe(false);
  });

  it('boosts confidence when 2 of 3 agree', () => {
    const det = [makeFinding({ key: 'deps:pkg.json:lodash', deterministicEvidence: ['unused'], sources: ['deterministic'] })];
    const sem = [makeFinding({ key: 'deps:pkg.json:lodash', semanticEvidence: ['codex: unused'], sources: ['semantic'] })];
    const host: CleanupFinding[] = [];

    const merged = mergeThreeWay(det, sem, host);

    expect(merged).toHaveLength(1);
    expect(merged[0].confidence).toBe('high');
    expect(merged[0].sources).toEqual(['deterministic', 'semantic']);
    expect(merged[0].disputed).toBe(false);
  });

  it('marks single-source findings as disputed but preserves original confidence', () => {
    const det: CleanupFinding[] = [];
    const sem = [makeFinding({ key: 'deps:pkg.json:lodash', confidence: 'high', semanticEvidence: ['codex: unused'], sources: ['semantic'] })];
    const host: CleanupFinding[] = [];

    const merged = mergeThreeWay(det, sem, host);

    expect(merged).toHaveLength(1);
    expect(merged[0].confidence).toBe('high'); // preserves original
    expect(merged[0].disputed).toBe(true);
    expect(merged[0].sources).toEqual(['semantic']);
  });

  it('merges evidence from all sources', () => {
    const det = [makeFinding({ key: 'k', deterministicEvidence: ['det-ev'], sources: ['deterministic'] })];
    const sem = [makeFinding({ key: 'k', semanticEvidence: ['sem-ev'], sources: ['semantic'] })];
    const host = [makeFinding({ key: 'k', hostEvidence: ['host-ev'], sources: ['host'] })];

    const merged = mergeThreeWay(det, sem, host);

    expect(merged[0].deterministicEvidence).toEqual(['det-ev']);
    expect(merged[0].semanticEvidence).toEqual(['sem-ev']);
    expect(merged[0].hostEvidence).toEqual(['host-ev']);
  });

  it('handles empty inputs', () => {
    const merged = mergeThreeWay([], [], []);
    expect(merged).toHaveLength(0);
  });

  it('normalizes keys with backslashes and ./ prefixes', () => {
    const det = [makeFinding({ key: 'deps:src\\utils.ts:lodash', deterministicEvidence: ['unused'], sources: ['deterministic'] })];
    const host = [makeFinding({ key: 'deps:./src/utils.ts:lodash', hostEvidence: ['host: unused'], sources: ['host'] })];

    const merged = mergeThreeWay(det, [], host);

    expect(merged).toHaveLength(1);
    expect(merged[0].key).toBe('deps:src/utils.ts:lodash');
    expect(merged[0].sources).toEqual(['deterministic', 'host']);
    expect(merged[0].confidence).toBe('high');
  });

  it('does not leak cross-source evidence into new entries', () => {
    const sem = [makeFinding({ key: 'a', semanticEvidence: ['sem-ev'], deterministicEvidence: ['should-not-leak'], sources: ['semantic'] })];

    const merged = mergeThreeWay([], sem, []);

    expect(merged[0].deterministicEvidence).toEqual([]);
    expect(merged[0].semanticEvidence).toEqual(['sem-ev']);
  });

  it('deduplicates by key across all sources', () => {
    const det = [makeFinding({ key: 'a' }), makeFinding({ key: 'b' })];
    const sem = [makeFinding({ key: 'b' }), makeFinding({ key: 'c' })];
    const host = [makeFinding({ key: 'c' }), makeFinding({ key: 'd' })];

    const merged = mergeThreeWay(det, sem, host);

    expect(merged).toHaveLength(4); // a, b, c, d
    const keys = merged.map(f => f.key).sort();
    expect(keys).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('mergeTwoWay', () => {
  it('wraps mergeThreeWay with empty host', () => {
    const det = [makeFinding({ key: 'a', sources: ['deterministic'] })];
    const sem = [makeFinding({ key: 'a', sources: ['semantic'] })];

    const merged = mergeTwoWay(det, sem);

    expect(merged).toHaveLength(1);
    expect(merged[0].sources).toEqual(['deterministic', 'semantic']);
    expect(merged[0].confidence).toBe('high');
  });
});

describe('computeThreeWayStats', () => {
  it('counts sources and agreement correctly', () => {
    const det = [makeFinding({ key: 'a' })];
    const sem = [makeFinding({ key: 'a' }), makeFinding({ key: 'b' })];
    const host = [makeFinding({ key: 'c' })];
    const merged = mergeThreeWay(det, sem, host);

    const stats = computeThreeWayStats(det, sem, host, merged);

    expect(stats.deterministic).toBe(1);
    expect(stats.semantic).toBe(2);
    expect(stats.host).toBe(1);
    expect(stats.agreed).toBe(1); // 'a' has 2 sources
    expect(stats.disputed).toBe(2); // 'b' and 'c' are single-source
  });
});

describe('computeTwoWayStats', () => {
  it('wraps computeThreeWayStats with host=0', () => {
    const det = [makeFinding({ key: 'a' })];
    const sem: CleanupFinding[] = [];
    const merged = mergeTwoWay(det, sem);

    const stats = computeTwoWayStats(det, sem, merged);

    expect(stats.host).toBe(0);
    expect(stats.deterministic).toBe(1);
  });
});

describe('recalculateConfidenceStats', () => {
  it('recalculates confidence counts from findings', () => {
    const findings = [
      makeFinding({ key: 'a', confidence: 'high' }),
      makeFinding({ key: 'b', confidence: 'high' }),
      makeFinding({ key: 'c', confidence: 'medium' }),
      makeFinding({ key: 'd', confidence: 'low' }),
    ];
    const stats = { deterministic: 0, semantic: 0, host: 0, agreed: 0, disputed: 0, adjudicated: 0, highConfidence: 0, mediumConfidence: 0, lowConfidence: 0 };

    recalculateConfidenceStats(findings, stats);

    expect(stats.highConfidence).toBe(2);
    expect(stats.mediumConfidence).toBe(1);
    expect(stats.lowConfidence).toBe(1);
  });
});
