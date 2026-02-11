// packages/core/src/config/migration.ts

import { copyFileSync, renameSync, writeFileSync } from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import type { ProjectConfig } from '../types/config.js';
import { ConfigError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('info');
const CURRENT_VERSION = 2;

/**
 * Migrate a ProjectConfig from an older schema version to the current version.
 * Creates a .bak backup before writing changes if configPath is provided.
 * Returns the migrated config (always in-memory; optionally persisted to disk).
 */
export function migrateConfig(config: ProjectConfig, configPath?: string): ProjectConfig {
  const fromVersion = config.configVersion ?? 1;

  if (fromVersion > CURRENT_VERSION) {
    throw new ConfigError(
      `Config version ${fromVersion} requires a newer version of CodeMoot. Please upgrade.`,
      'configVersion',
    );
  }

  if (fromVersion >= CURRENT_VERSION) return config;

  // Pre-migration backup
  if (configPath) {
    const backupPath = `${configPath}.bak`;
    try {
      copyFileSync(configPath, backupPath);
      log.info(`Config backup created at ${backupPath}`);
    } catch {
      log.warn('Failed to create config backup');
    }
  }

  let migrated = { ...config };

  if (fromVersion < 2) {
    migrated = migrateV1ToV2(migrated);
  }

  // Write back (atomic: write to temp then rename)
  if (configPath) {
    const tmpPath = `${configPath}.tmp`;
    try {
      const content = stringifyYaml(migrated, { lineWidth: 100 });
      writeFileSync(tmpPath, content, 'utf-8');
      renameSync(tmpPath, configPath);
      log.info(`Config migrated from v${fromVersion} to v${CURRENT_VERSION}`);
    } catch (err) {
      log.warn(
        `Failed to write migrated config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return migrated;
}

function migrateV1ToV2(config: ProjectConfig): ProjectConfig {
  return { ...config, configVersion: 2 };
}

export { CURRENT_VERSION };
