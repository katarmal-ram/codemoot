// packages/core/src/config/presets.ts

import type { PresetName } from '../types/config.js';

/** Inline preset configs — no external YAML files needed */
const PRESET_CONFIGS: Record<PresetName, Record<string, unknown>> = {
  'cli-first': {
    models: {
      'codex-architect': {
        provider: 'openai',
        model: 'gpt-5.3-codex',
        maxTokens: 4096,
        temperature: 0.7,
        timeout: 120,
      },
      'codex-reviewer': {
        provider: 'openai',
        model: 'gpt-5.3-codex',
        maxTokens: 4096,
        temperature: 0.3,
        timeout: 120,
      },
    },
    roles: {
      architect: {
        model: 'codex-architect',
        temperature: 0.7,
        maxTokens: 4096,
      },
      reviewer: {
        model: 'codex-reviewer',
        temperature: 0.3,
        maxTokens: 4096,
      },
    },
  },
};

const VALID_PRESETS: PresetName[] = ['cli-first'];

/**
 * Load a built-in preset by name. Returns a partial config to be merged with defaults.
 */
export function loadPreset(name: PresetName): Record<string, unknown> {
  if (!VALID_PRESETS.includes(name)) {
    // Gracefully fall back to cli-first for legacy preset names (balanced, budget)
    console.error(`Warning: Unknown preset "${name}", falling back to "cli-first".`);
    name = 'cli-first';
  }

  return structuredClone(PRESET_CONFIGS[name]);
}

/** List available preset names. */
export function listPresets(): PresetName[] {
  return [...VALID_PRESETS];
}
