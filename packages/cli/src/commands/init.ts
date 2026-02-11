import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { PresetName } from '@codemoot/core';
import { loadConfig, writeConfig } from '@codemoot/core';
import chalk from 'chalk';

interface InitOptions {
  preset?: string;
  nonInteractive?: boolean;
  force?: boolean;
}

export async function initCommand(options: InitOptions): Promise<void> {
  const cwd = process.cwd();
  const configPath = join(cwd, '.cowork.yml');

  // Check existing config
  if (existsSync(configPath) && !options.force) {
    console.error(chalk.red('Already initialized. Use --force to overwrite.'));
    process.exit(1);
  }

  // Validate preset name
  const validPresets: PresetName[] = ['cli-first'];
  // Select preset
  let presetName: PresetName = 'cli-first';
  if (options.preset) {
    if (!validPresets.includes(options.preset as PresetName)) {
      console.error(chalk.red(`Unknown preset: ${options.preset}. Available: ${validPresets.join(', ')}`));
      process.exit(1);
    }
    presetName = options.preset as PresetName;
  } else if (options.nonInteractive) {
    presetName = 'cli-first';
  } else {
    const { selectPreset } = await import('../prompts.js');
    presetName = await selectPreset();
  }

  // Load config with preset (skip existing file on --force)
  const config = loadConfig({ preset: presetName, skipFile: options.force });
  // Set project name to directory name
  config.project.name = basename(cwd);

  // Write config
  writeConfig(config, cwd);

  console.log(chalk.green(`\nInitialized with '${presetName}' preset`));

  // Show model assignments from config
  const modelEntries = Object.entries(config.models);
  for (const [alias, modelConfig] of modelEntries) {
    console.log(chalk.gray(`  ${alias}: ${modelConfig.model}`));
  }

  console.log(chalk.gray('\nNext: codemoot plan "describe your task"'));
}
