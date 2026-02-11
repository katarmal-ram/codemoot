import { describe, expect, it } from 'vitest';
import { parseVerdict } from '../../../src/utils/verdict.js';

describe('parseVerdict', () => {
  it('parses APPROVED verdict', () => {
    const result = parseVerdict('The code looks great.\n\nVERDICT: APPROVED');
    expect(result.verdict).toBe('approved');
    expect(result.feedback).toBe('');
  });

  it('parses NEEDS_REVISION verdict with feedback', () => {
    const response =
      'There are several issues:\n1. Missing error handling\n2. No tests\n\nVERDICT: NEEDS_REVISION';
    const result = parseVerdict(response);
    expect(result.verdict).toBe('needs_revision');
    expect(result.feedback).toContain('Missing error handling');
    expect(result.feedback).toContain('No tests');
  });

  it('returns needs_revision when no verdict found (conservative)', () => {
    const result = parseVerdict('I think the code could be improved but I have no strong opinion.');
    expect(result.verdict).toBe('needs_revision');
    expect(result.feedback).toBe(
      'I think the code could be improved but I have no strong opinion.',
    );
  });

  it('handles case-insensitive verdict', () => {
    const result = parseVerdict('Looks good.\n\nverdict: approved');
    expect(result.verdict).toBe('approved');
  });

  it('handles verdict with extra whitespace', () => {
    const result = parseVerdict('OK.\n\nVERDICT:   APPROVED');
    expect(result.verdict).toBe('approved');
  });

  it('extracts feedback before NEEDS_REVISION', () => {
    const response = 'Fix the bug on line 42.\n\nVERDICT: NEEDS_REVISION';
    const result = parseVerdict(response);
    expect(result.verdict).toBe('needs_revision');
    expect(result.feedback).toBe('Fix the bug on line 42.');
  });

  it('handles empty string', () => {
    const result = parseVerdict('');
    expect(result.verdict).toBe('needs_revision');
    expect(result.feedback).toBe('');
  });

  it('handles verdict at the very start', () => {
    const result = parseVerdict('VERDICT: APPROVED');
    expect(result.verdict).toBe('approved');
    expect(result.feedback).toBe('');
  });

  it('uses first verdict match if multiple exist', () => {
    const response = 'VERDICT: APPROVED\nActually wait...\nVERDICT: NEEDS_REVISION';
    const result = parseVerdict(response);
    expect(result.verdict).toBe('approved');
  });
});
