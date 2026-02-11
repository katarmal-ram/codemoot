import { describe, expect, it } from 'vitest';
import { getReviewPreset, listPresetNames, REVIEW_PRESETS } from '../../../src/config/review-presets.js';

describe('review presets', () => {
  it('has 5 built-in presets', () => {
    expect(listPresetNames()).toHaveLength(5);
  });

  it('returns preset by name', () => {
    const p = getReviewPreset('security-audit');
    expect(p).toBeDefined();
    expect(p?.focus).toBe('security');
    expect(p?.timeoutSec).toBe(1200);
    expect(p?.constraints.length).toBeGreaterThan(0);
  });

  it('returns undefined for unknown preset', () => {
    expect(getReviewPreset('nonexistent')).toBeUndefined();
  });

  it('all presets have required fields', () => {
    for (const name of listPresetNames()) {
      const p = REVIEW_PRESETS[name];
      expect(p.name).toBe(name);
      expect(p.focus).toBeTruthy();
      expect(p.timeoutSec).toBeGreaterThan(0);
      expect(p.severityFloor).toBeTruthy();
    }
  });

  it('quick-scan has short timeout', () => {
    const p = getReviewPreset('quick-scan');
    expect(p?.timeoutSec).toBeLessThanOrEqual(300);
  });
});
