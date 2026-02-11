import { writeFileSync } from 'node:fs';

import { ModelRegistry, Orchestrator, loadConfig, openDatabase } from '@codemoot/core';
import chalk from 'chalk';

import { printSessionSummary, renderEvent } from '../render.js';
import { getDbPath } from '../utils.js';

interface PlanOptions {
  rounds?: number;
  output?: string;
}

export async function planCommand(task: string, options: PlanOptions): Promise<void> {
  try {
    const config = loadConfig();
    const projectDir = process.cwd();
    const registry = ModelRegistry.fromConfig(config, projectDir);

    const health = await registry.healthCheckAll();
    for (const [alias, hasKey] of health) {
      if (!hasKey) {
        console.warn(chalk.yellow(`Warning: No API key for model "${alias}"`));
      }
    }

    const dbPath = getDbPath();
    const db = openDatabase(dbPath);

    const orchestrator = new Orchestrator({ registry, db, config });
    orchestrator.on('event', (event) => renderEvent(event, config));

    const result = await orchestrator.plan(task, {
      maxRounds: options.rounds,
    });

    // Save to file if requested
    if (options.output) {
      writeFileSync(options.output, result.finalOutput, 'utf-8');
      console.log(chalk.green(`Plan saved to ${options.output}`));
    }

    printSessionSummary(result);

    db.close();
    process.exit(result.status === 'completed' ? 0 : 2);
  } catch (error) {
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}
