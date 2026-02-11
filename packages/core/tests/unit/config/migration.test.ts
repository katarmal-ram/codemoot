import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { CURRENT_VERSION, migrateConfig } from '../../../src/config/migration.js';
import type { ProjectConfig } from '../../../src/types/config.js';
import { ConfigError } from '../../../src/utils/errors.js';

const TEST_DIR = join(tmpdir(), `codemoot-migration-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Build a minimal v1 config (no configVersion). */
function makeV1Config(): ProjectConfig {
  return {
    ...DEFAULT_CONFIG,
    project: { name: 'test-project', description: 'test' },
  };
}

describe('migrateConfig', () => {
  it('migrates v1 config: adds configVersion 2', () => {
    const v1 = makeV1Config();
    const v1WithoutVersion = { ...v1 };
    v1WithoutVersion.configVersion = undefined;

    const migrated = migrateConfig(v1WithoutVersion);

    expect(migrated.configVersion).toBe(2);
  });

  it('returns config unchanged when already at current version', () => {
    const v2Config: ProjectConfig = {
      ...DEFAULT_CONFIG,
      configVersion: 2,
    };

    const result = migrateConfig(v2Config);
    expect(result).toBe(v2Config);
    expect(result.configVersion).toBe(2);
  });

  it('throws ConfigError for future config version', () => {
    const futureConfig: ProjectConfig = {
      ...DEFAULT_CONFIG,
      configVersion: 99,
    };

    expect(() => migrateConfig(futureConfig)).toThrow(ConfigError);
    expect(() => migrateConfig(futureConfig)).toThrow('requires a newer version');
  });

  it('preserves unknown fields for forward compatibility', () => {
    const v1 = makeV1Config() as Record<string, unknown>;
    v1.customField = 'should-survive';
    v1.configVersion = undefined;

    const migrated = migrateConfig(v1 as ProjectConfig) as Record<string, unknown>;

    expect(migrated.customField).toBe('should-survive');
    expect(migrated.configVersion).toBe(2);
  });

  it('creates backup file before migration when configPath is provided', () => {
    const configPath = join(TEST_DIR, '.cowork.yml');
    const v1 = makeV1Config();
    writeFileSync(configPath, stringifyYaml(v1), 'utf-8');

    migrateConfig(v1, configPath);

    const backupPath = `${configPath}.bak`;
    expect(existsSync(backupPath)).toBe(true);
    const backupContent = readFileSync(backupPath, 'utf-8');
    expect(backupContent).toContain('plan-review-implement');
  });

  it('does not crash when backup creation fails', () => {
    const v1 = makeV1Config();
    const bogusPath = join(TEST_DIR, 'nonexistent', 'deep', 'config.yml');

    const migrated = migrateConfig(v1, bogusPath);
    expect(migrated.configVersion).toBe(2);
  });

  it('round-trip: all original fields are preserved after migration', () => {
    const v1 = makeV1Config();
    v1.configVersion = undefined;

    const migrated = migrateConfig(v1);

    expect(migrated.project.name).toBe(v1.project.name);
    expect(migrated.workflow).toBe(v1.workflow);
    expect(migrated.mode).toBe(v1.mode);
    expect(migrated.debate.maxRounds).toBe(v1.debate.maxRounds);

    for (const alias of Object.keys(v1.models)) {
      expect(migrated.models[alias].provider).toBe(v1.models[alias].provider);
      expect(migrated.models[alias].model).toBe(v1.models[alias].model);
    }
  });

  it('treats missing configVersion as v1', () => {
    const config = makeV1Config();
    const asRecord = config as Record<string, unknown>;
    asRecord.configVersion = undefined;

    const migrated = migrateConfig(config);
    expect(migrated.configVersion).toBe(2);
  });

  it('writes migrated config back to disk when configPath is provided', () => {
    const configPath = join(TEST_DIR, '.cowork.yml');
    const v1 = makeV1Config();
    writeFileSync(configPath, stringifyYaml(v1), 'utf-8');

    migrateConfig(v1, configPath);

    const written = readFileSync(configPath, 'utf-8');
    expect(written).toContain('configVersion: 2');
  });
});

describe('CURRENT_VERSION', () => {
  it('is 2', () => {
    expect(CURRENT_VERSION).toBe(2);
  });
});
