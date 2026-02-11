// packages/core/src/cleanup/merge.ts — 3-way merge logic for cleanup findings

import type { CleanupFinding, CleanupReport } from '../types/cleanup.js';

/** Normalize keys: forward slashes, strip ./ prefix from each segment */
function normalizeKey(key: string): string {
  return key
    .replaceAll('\\', '/')
    .split(':')
    .map(s => s.replace(/^\.\//, ''))
    .join(':');
}

/** Count unique keys in a findings array. */
function uniqueKeyCount(findings: CleanupFinding[]): number {
  const seen = new Set<string>();
  for (const f of findings) seen.add(normalizeKey(f.key));
  return seen.size;
}

/**
 * Merge findings from up to 3 sources: deterministic, semantic (codex), and host (Claude).
 * Agreement rules:
 * - All 3 agree → confidence: high
 * - 2 of 3 agree → confidence: high (majority)
 * - Only 1 found → original confidence preserved, disputed: true
 */
export function mergeThreeWay(
  deterministic: CleanupFinding[],
  semantic: CleanupFinding[],
  host: CleanupFinding[],
): CleanupFinding[] {
  const merged = new Map<string, CleanupFinding>();
  const sourceSet = new Map<string, Set<string>>();

  // Add all deterministic findings (merge duplicates within same source)
  for (const f of deterministic) {
    const nk = normalizeKey(f.key);
    const existing = merged.get(nk);
    if (existing) {
      existing.deterministicEvidence.push(...f.deterministicEvidence);
    } else {
      merged.set(nk, {
        ...f,
        key: nk,
        deterministicEvidence: [...f.deterministicEvidence],
        semanticEvidence: [],
        hostEvidence: [],
        sources: [],
      });
      sourceSet.set(nk, new Set());
    }
    (sourceSet.get(nk) as Set<string>).add('deterministic');
  }

  // Merge semantic findings
  for (const f of semantic) {
    const nk = normalizeKey(f.key);
    const existing = merged.get(nk);
    if (existing) {
      existing.semanticEvidence.push(...f.semanticEvidence);
    } else {
      merged.set(nk, {
        ...f,
        key: nk,
        deterministicEvidence: [],
        semanticEvidence: [...f.semanticEvidence],
        hostEvidence: [],
        sources: [],
      });
      sourceSet.set(nk, new Set());
    }
    (sourceSet.get(nk) as Set<string>).add('semantic');
  }

  // Merge host findings
  for (const f of host) {
    const nk = normalizeKey(f.key);
    const existing = merged.get(nk);
    if (existing) {
      existing.hostEvidence.push(...f.hostEvidence);
    } else {
      merged.set(nk, {
        ...f,
        key: nk,
        deterministicEvidence: [],
        semanticEvidence: [],
        hostEvidence: [...f.hostEvidence],
        sources: [],
      });
      sourceSet.set(nk, new Set());
    }
    (sourceSet.get(nk) as Set<string>).add('host');
  }

  // Apply confidence rules based on unique source count
  for (const [key, finding] of merged) {
    const sources = sourceSet.get(key) as Set<string>;
    finding.sources = Array.from(sources) as CleanupFinding['sources'];
    const count = sources.size;
    if (count >= 2) {
      finding.confidence = 'high';
      finding.disputed = false;
    } else {
      // Single source: keep original confidence, but mark as disputed
      finding.disputed = true;
    }
  }

  return Array.from(merged.values());
}

/**
 * Compute stats from merged findings with 3-source tracking.
 */
export function computeThreeWayStats(
  deterministic: CleanupFinding[],
  semantic: CleanupFinding[],
  host: CleanupFinding[],
  merged: CleanupFinding[],
): CleanupReport['stats'] {
  return {
    deterministic: uniqueKeyCount(deterministic),
    semantic: uniqueKeyCount(semantic),
    host: uniqueKeyCount(host),
    agreed: merged.filter(f => f.sources.length >= 2).length,
    disputed: merged.filter(f => f.disputed).length,
    adjudicated: 0,
    highConfidence: merged.filter(f => f.confidence === 'high').length,
    mediumConfidence: merged.filter(f => f.confidence === 'medium').length,
    lowConfidence: merged.filter(f => f.confidence === 'low').length,
  };
}

/**
 * Legacy 2-way merge (deterministic + semantic only). Wraps mergeThreeWay with empty host.
 */
export function mergeTwoWay(
  deterministic: CleanupFinding[],
  semantic: CleanupFinding[],
): CleanupFinding[] {
  return mergeThreeWay(deterministic, semantic, []);
}

/**
 * Legacy 2-way stats. Wraps computeThreeWayStats with empty host.
 */
export function computeTwoWayStats(
  deterministic: CleanupFinding[],
  semantic: CleanupFinding[],
  merged: CleanupFinding[],
): CleanupReport['stats'] {
  return computeThreeWayStats(deterministic, semantic, [], merged);
}

/**
 * Recalculate stats after adjudication modifies findings in place.
 * Note: `stats.adjudicated` is managed by the caller (incremented per adjudication).
 */
export function recalculateConfidenceStats(
  findings: CleanupFinding[],
  stats: CleanupReport['stats'],
): void {
  stats.highConfidence = findings.filter(f => f.confidence === 'high').length;
  stats.mediumConfidence = findings.filter(f => f.confidence === 'medium').length;
  stats.lowConfidence = findings.filter(f => f.confidence === 'low').length;
  stats.agreed = findings.filter(f => f.sources.length >= 2).length;
  stats.disputed = findings.filter(f => f.disputed).length;
}
