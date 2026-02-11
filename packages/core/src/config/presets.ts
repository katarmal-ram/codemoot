// packages/core/src/config/presets.ts

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { PresetName } from '../types/config.js';
import { ConfigError } from '../utils/errors.js';

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'presets');

const VALID_PRESETS: PresetName[] = ['cli-first'];

/**
 * Load a built-in preset by name. Returns a partial config to be merged with defaults.
 */
export function loadPreset(name: PresetName): Record<string, unknown> {
  if (!VALID_PRESETS.includes(name)) {
    throw new ConfigError(
      `Unknown preset: "${name}". Valid presets: ${VALID_PRESETS.join(', ')}`,
      'preset',
    );
  }

  const filePath = join(PRESETS_DIR, `${name}.yml`);
  try {
    const content = readFileSync(filePath, 'utf-8');
    return parseYaml(content) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(
      `Failed to load preset "${name}": ${err instanceof Error ? err.message : String(err)}`,
      'preset',
    );
  }
}

/** List available preset names. */
export function listPresets(): PresetName[] {
  return [...VALID_PRESETS];
}
