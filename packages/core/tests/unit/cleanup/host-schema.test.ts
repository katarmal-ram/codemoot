import { describe, expect, it } from 'vitest';
import { hostFindingsSchema } from '../../../src/cleanup/host-schema.js';

describe('hostFindingsSchema', () => {
  it('validates a correct deps finding', () => {
    const input = [{
      scope: 'deps',
      confidence: 'high',
      file: 'package.json',
      line: 5,
      symbol: 'lodash',
      description: 'Unused dependency',
      recommendation: 'Remove it',
    }];

    const result = hostFindingsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('validates scoped package names for deps', () => {
    const input = [{
      scope: 'deps',
      confidence: 'high',
      file: 'package.json',
      symbol: '@types/node',
      description: 'Unused',
      recommendation: 'Remove',
    }];

    const result = hostFindingsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('validates unused-exports symbol as identifier', () => {
    const input = [{
      scope: 'unused-exports',
      confidence: 'medium',
      file: 'src/utils.ts',
      symbol: 'myFunction',
      description: 'Never imported',
      recommendation: 'Remove export',
    }];

    const result = hostFindingsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('validates hardcoded num format', () => {
    const input = [{
      scope: 'hardcoded',
      confidence: 'medium',
      file: 'src/config.ts',
      line: 15,
      symbol: 'num:42:L15',
      description: 'Magic number',
      recommendation: 'Use a constant',
    }];

    const result = hostFindingsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('validates hardcoded url format', () => {
    const input = [{
      scope: 'hardcoded',
      confidence: 'medium',
      file: 'src/api.ts',
      symbol: 'url:api.example.com:L20',
      description: 'Hardcoded URL',
      recommendation: 'Use env var',
    }];

    const result = hostFindingsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('validates hardcoded cred format', () => {
    const input = [{
      scope: 'hardcoded',
      confidence: 'high',
      file: 'src/auth.ts',
      symbol: 'cred:L15',
      description: 'Credential pattern',
      recommendation: 'Use env var',
    }];

    const result = hostFindingsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('validates duplicates hash:name format', () => {
    const input = [{
      scope: 'duplicates',
      confidence: 'medium',
      file: 'src/utils.ts',
      symbol: 'a1b2c3d4:myFunction',
      description: 'Duplicate logic',
      recommendation: 'Extract shared utility',
    }];

    const result = hostFindingsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('validates deadcode symbol as identifier', () => {
    const input = [{
      scope: 'deadcode',
      confidence: 'low',
      file: 'src/old.ts',
      symbol: 'unusedHelper',
      description: 'Never called',
      recommendation: 'Remove',
    }];

    const result = hostFindingsSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects invalid scope', () => {
    const input = [{
      scope: 'invalid',
      confidence: 'high',
      file: 'a.ts',
      symbol: 'x',
      description: 'd',
      recommendation: 'r',
    }];

    const result = hostFindingsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects invalid symbol pattern for hardcoded scope', () => {
    const input = [{
      scope: 'hardcoded',
      confidence: 'high',
      file: 'a.ts',
      symbol: 'not-a-valid-pattern',
      description: 'd',
      recommendation: 'r',
    }];

    const result = hostFindingsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects empty array fields', () => {
    const input = [{
      scope: 'deps',
      confidence: 'high',
      file: '',
      symbol: 'lodash',
      description: 'test',
      recommendation: 'fix',
    }];

    const result = hostFindingsSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('accepts empty array', () => {
    const result = hostFindingsSchema.safeParse([]);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });
});
