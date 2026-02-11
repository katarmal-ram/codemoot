import type { PresetName } from '@codemoot/core';

export async function selectPreset(): Promise<PresetName> {
  // CLI-first is the only valid preset — no need to prompt
  return 'cli-first';
}
