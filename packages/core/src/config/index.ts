// packages/core/src/config/index.ts -- barrel re-export

export { DEFAULT_CONFIG } from './defaults.js';
export { projectConfigSchema, validateConfig } from './schema.js';
export type { ProjectConfigInput } from './schema.js';
export { loadPreset, listPresets } from './presets.js';
export { loadConfig, writeConfig } from './loader.js';
export { migrateConfig, CURRENT_VERSION } from './migration.js';
export { getReviewPreset, listPresetNames, REVIEW_PRESETS } from './review-presets.js';
export type { ReviewPreset } from './review-presets.js';
export { createIgnoreFilter, loadIgnorePatterns, shouldIgnore } from './ignore.js';
