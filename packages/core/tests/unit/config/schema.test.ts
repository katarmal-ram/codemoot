import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { projectConfigSchema, validateConfig } from '../../../src/config/schema.js';

describe('projectConfigSchema', () => {
  it('validates a complete valid config', () => {
    const result = projectConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  it('applies defaults for missing optional fields', () => {
    const minimal = {
      models: {
        test: {
          provider: 'openai',
          model: 'gpt-5.3-codex',
        },
      },
      roles: {
        architect: { model: 'test' },
      },
    };
    const result = projectConfigSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe('autonomous');
      expect(result.data.advanced.logLevel).toBe('info');
      expect(result.data.budget.perSession).toBe(5.0);
      expect(result.data.debate.maxRounds).toBe(3);
    }
  });

  it('rejects invalid provider', () => {
    const bad = {
      ...DEFAULT_CONFIG,
      models: {
        test: {
          provider: 'invalid_provider',
          model: 'test',
        },
      },
    };
    const result = projectConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects temperature out of range', () => {
    const bad = {
      ...DEFAULT_CONFIG,
      models: {
        test: {
          provider: 'openai',
          model: 'test',
          temperature: 5.0,
        },
      },
    };
    const result = projectConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects invalid execution mode', () => {
    const bad = { ...DEFAULT_CONFIG, mode: 'turbo' };
    const result = projectConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects empty model name', () => {
    const bad = {
      ...DEFAULT_CONFIG,
      models: {
        test: {
          provider: 'openai',
          model: '',
        },
      },
    };
    const result = projectConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('validateConfig', () => {
  it('returns validated config for valid input', () => {
    const config = validateConfig(DEFAULT_CONFIG);
    expect(config.mode).toBe('autonomous');
    expect(config.models['codex-architect'].provider).toBe('openai');
  });

  it('throws ConfigError for invalid input', () => {
    expect(() => validateConfig({ models: 'not an object' })).toThrow('Invalid configuration');
  });

  it('throws ConfigError with field details', () => {
    try {
      validateConfig({ models: { bad: { provider: 'nope' } } });
    } catch (err) {
      expect((err as Error).name).toBe('ConfigError');
      expect((err as Error).message).toContain('Invalid configuration');
    }
  });
});
