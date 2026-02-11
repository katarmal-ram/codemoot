import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { ModelRegistry } from '../../../src/models/registry.js';
import { CliAdapter } from '../../../src/models/cli-adapter.js';

// Mock child_process to prevent actual CLI calls
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(new Error('mock'), '', '');
  }),
}));

describe('ModelRegistry', () => {
  it('creates registry from config', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    expect(registry.listAliases()).toContain('codex-architect');
    expect(registry.listAliases()).toContain('codex-reviewer');
  });

  it('getAdapter returns a CliAdapter for valid alias', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    const adapter = registry.getAdapter('codex-architect');
    expect(adapter).toBeInstanceOf(CliAdapter);
  });

  it('getAdapter throws for unknown alias', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    expect(() => registry.getAdapter('nonexistent')).toThrow('Unknown model alias');
  });

  it('getAdapterForRole resolves role -> alias -> adapter', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    const adapter = registry.getAdapterForRole('architect', DEFAULT_CONFIG);
    expect(adapter).toBeInstanceOf(CliAdapter);
  });

  it('getAdapterForRole throws for unknown role', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    expect(() => registry.getAdapterForRole('nonexistent', DEFAULT_CONFIG)).toThrow('Unknown role');
  });

  it('getModelConfig returns config for valid alias', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    const config = registry.getModelConfig('codex-architect');
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-5.3-codex');
  });

  it('getModelConfigForRole resolves role -> config', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    const config = registry.getModelConfigForRole('reviewer', DEFAULT_CONFIG);
    expect(config.provider).toBe('openai');
  });

  it('isCliMode always returns true', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    expect(registry.isCliMode('codex-architect')).toBe(true);
  });

  it('listAliases returns all registered aliases', () => {
    const registry = ModelRegistry.fromConfig(DEFAULT_CONFIG);
    const aliases = registry.listAliases();
    expect(aliases.length).toBeGreaterThanOrEqual(2);
  });
});
