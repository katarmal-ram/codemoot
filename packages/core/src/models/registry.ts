// packages/core/src/models/registry.ts — CLI-only model registry

import type { ModelConfig, ProjectConfig } from '../types/config.js';
import { ModelError } from '../utils/errors.js';
import { CliAdapter } from './cli-adapter.js';
import { detectCli } from './cli-detector.js';

/** All models are CLI adapters now. */
export type ModelAdapter = CliAdapter;

export class ModelRegistry {
  private models = new Map<string, ModelAdapter>();
  private configs = new Map<string, ModelConfig>();
  private constructor() {}

  /**
   * Build a registry from a ProjectConfig.
   * All models are CLI adapters (codex).
   */
  static fromConfig(config: ProjectConfig, projectDir?: string): ModelRegistry {
    const registry = new ModelRegistry();
    for (const [alias, modelConfig] of Object.entries(config.models)) {
      registry.models.set(alias, createCliAdapter(modelConfig, projectDir));
      registry.configs.set(alias, modelConfig);
    }
    return registry;
  }

  /**
   * Resolve auto mode — probe codex CLI availability.
   * Kept for API compatibility; all models are CLI now.
   */
  async resolveAutoMode(): Promise<void> {
    // No-op: all models are CLI adapters, no auto detection needed
  }

  /** Get the adapter for an alias, or null if not found. */
  tryGetAdapter(alias: string): ModelAdapter | null {
    return this.models.get(alias) ?? null;
  }

  /** Get the adapter for an alias. Throws if not found. */
  getAdapter(alias: string): ModelAdapter {
    const adapter = this.models.get(alias);
    if (!adapter) {
      throw new ModelError(
        `Unknown model alias: "${alias}". Available: ${[...this.models.keys()].join(', ')}`,
      );
    }
    return adapter;
  }

  /** Check if an alias is backed by CLI adapter (always true now). */
  isCliMode(_alias: string): boolean {
    return true;
  }

  /** Get the ModelConfig for an alias. */
  getModelConfig(alias: string): ModelConfig {
    const config = this.configs.get(alias);
    if (!config) {
      throw new ModelError(`Unknown model alias: "${alias}"`);
    }
    return config;
  }

  /** Resolve role -> alias -> ModelAdapter. */
  getAdapterForRole(role: string, config: ProjectConfig): ModelAdapter {
    const roleConfig = config.roles[role];
    if (!roleConfig) {
      throw new ModelError(
        `Unknown role: "${role}". Available: ${Object.keys(config.roles).join(', ')}`,
      );
    }
    return this.getAdapter(roleConfig.model);
  }

  /** Resolve role -> alias -> ModelConfig. */
  getModelConfigForRole(role: string, config: ProjectConfig): ModelConfig {
    const roleConfig = config.roles[role];
    if (!roleConfig) {
      throw new ModelError(`Unknown role: "${role}"`);
    }
    return this.getModelConfig(roleConfig.model);
  }

  /** List all registered model aliases. */
  listAliases(): string[] {
    return [...this.models.keys()];
  }

  /**
   * Health check: verify codex CLI is available and authenticated.
   */
  async healthCheckAll(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    // All models use codex CLI — only check availability (no API key needed)
    const detection = await detectCli('codex');
    for (const alias of this.configs.keys()) {
      results.set(alias, detection.available);
    }
    return results;
  }
}

/** Create a CliAdapter from model config. */
function createCliAdapter(config: ModelConfig, projectDir?: string): CliAdapter {
  const adapterConfig = config.cliAdapter ?? getDefaultCliConfig(projectDir);
  return new CliAdapter({
    command: adapterConfig.command,
    args: adapterConfig.args,
    provider: config.provider,
    model: config.model,
    cliName: 'codex',
    projectDir,
  });
}

/** Default codex CLI adapter config. */
function getDefaultCliConfig(projectDir?: string): {
  command: string;
  args: string[];
  timeout: number;
} {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const args = projectDir ? ['exec'] : ['exec', '--skip-git-repo-check'];
  return {
    command: `codex${ext}`,
    args,
    timeout: 600_000,
  };
}

export { createCliAdapter };
