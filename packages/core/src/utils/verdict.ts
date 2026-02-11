// packages/core/src/utils/verdict.ts

export interface VerdictResult {
  verdict: 'approved' | 'needs_revision';
  feedback: string;
}

const VERDICT_PATTERN = /VERDICT:\s*(APPROVED|NEEDS_REVISION)/i;

/**
 * Parse a reviewer response to extract the verdict.
 *
 * Looks for "VERDICT: APPROVED" or "VERDICT: NEEDS_REVISION" in the response.
 * If APPROVED, feedback is empty.
 * If NEEDS_REVISION, feedback is the text before the verdict line.
 * If no match, conservatively returns needs_revision with the full response as feedback.
 */
export function parseVerdict(response: string): VerdictResult {
  const match = VERDICT_PATTERN.exec(response);

  if (!match) {
    return { verdict: 'needs_revision', feedback: response.trim() };
  }

  const verdictStr = match[1].toUpperCase();

  if (verdictStr === 'APPROVED') {
    return { verdict: 'approved', feedback: '' };
  }

  // NEEDS_REVISION: feedback is everything before the VERDICT line
  const verdictIndex = match.index;
  const feedback = response.slice(0, verdictIndex).trim();
  return { verdict: 'needs_revision', feedback };
}
