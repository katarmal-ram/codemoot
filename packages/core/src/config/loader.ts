// packages/core/src/config/loader.ts

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { PresetName, ProjectConfig } from '../types/config.js';
import { ConfigError } from '../utils/errors.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { loadPreset } from './presets.js';
import { validateConfig } from './schema.js';

const CONFIG_FILENAME = '.cowork.yml';

/**
 * Deep merge two objects. Source values overwrite target values.
 * Arrays are replaced, not merged.
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result as T;
}

/**
 * Load config with precedence: overrides > .cowork.yml > preset > defaults.
 *
 * 1. Start with hardcoded defaults
 * 2. If a preset name is found (in file or overrides), merge preset on top
 * 3. Merge .cowork.yml from projectDir on top
 * 4. Merge programmatic overrides on top
 * 5. Validate the final result
 */
export function loadConfig(options?: {
  projectDir?: string;
  preset?: PresetName;
  overrides?: Partial<ProjectConfig>;
  skipFile?: boolean;
}): ProjectConfig {
  const projectDir = options?.projectDir ?? process.cwd();
  let merged: Record<string, unknown> = structuredClone(DEFAULT_CONFIG) as unknown as Record<
    string,
    unknown
  >;

  // Layer 2: Preset
  if (options?.preset) {
    const presetConfig = loadPreset(options.preset);
    merged = deepMerge(merged, presetConfig);
  }

  // Layer 3: Project file (.cowork.yml)
  const configPath = join(projectDir, CONFIG_FILENAME);
  if (!options?.skipFile && existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      const fileConfig = parseYaml(content) as Record<string, unknown>;
      if (fileConfig && typeof fileConfig === 'object') {
        merged = deepMerge(merged, fileConfig);
      }
    } catch (err) {
      throw new ConfigError(
        `Failed to parse ${CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Layer 4: Programmatic overrides
  if (options?.overrides) {
    merged = deepMerge(merged, options.overrides as Record<string, unknown>);
  }

  return validateConfig(merged);
}

/**
 * Write a ProjectConfig to .cowork.yml in the given directory.
 * Also creates .cowork/db/ and .cowork/transcripts/ directories.
 */
export function writeConfig(config: ProjectConfig, dir: string): void {
  const configPath = join(dir, CONFIG_FILENAME);
  const yamlContent = stringifyYaml(config, { lineWidth: 100 });
  writeFileSync(configPath, yamlContent, 'utf-8');

  // Create project directories
  mkdirSync(join(dir, '.cowork', 'db'), { recursive: true });
  mkdirSync(join(dir, '.cowork', 'transcripts'), { recursive: true });

  // Append to .gitignore if not already there
  const gitignorePath = join(dir, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.cowork/')) {
      appendFileSync(gitignorePath, '\n.cowork/\n');
    }
  } else {
    writeFileSync(gitignorePath, '.cowork/\n', 'utf-8');
  }
}

export { deepMerge };
