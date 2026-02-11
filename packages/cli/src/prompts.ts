import type { PresetName } from '@codemoot/core';

export async function selectPreset(): Promise<PresetName> {
  const { default: inquirer } = await import('inquirer');

  const { preset } = await inquirer.prompt([
    {
      type: 'select',
      name: 'preset',
      message: 'Select a preset:',
      choices: [
        { name: 'Balanced - Claude + GPT dual-model (recommended)', value: 'balanced' },
        { name: 'Budget - Lower cost, fewer iterations', value: 'budget' },
      ],
    },
  ]);

  return preset as PresetName;
}
