import type { ExecutionMode } from '@codemoot/core';
import { ModelRegistry, Orchestrator, loadConfig, openDatabase } from '@codemoot/core';
import chalk from 'chalk';

import { printSessionSummary, renderEvent } from '../render.js';
import { getDbPath } from '../utils.js';

interface RunOptions {
  mode?: string;
  maxIterations?: number;
  stream?: boolean;
}

export async function runCommand(task: string, options: RunOptions): Promise<void> {
  try {
    // 1. Load config
    const config = loadConfig();

    // 2. Create model registry (pass cwd so codex runs in the project dir)
    const projectDir = process.cwd();
    const registry = ModelRegistry.fromConfig(config, projectDir);

    // 3. Health check
    const health = await registry.healthCheckAll();
    for (const [alias, hasKey] of health) {
      if (!hasKey) {
        console.warn(chalk.yellow(`Warning: No API key for model "${alias}"`));
      }
    }

    // 4. Open database
    const dbPath = getDbPath();
    const db = openDatabase(dbPath);

    // 5. Create orchestrator
    const orchestrator = new Orchestrator({ registry, db, config });

    // 6. Subscribe to events
    orchestrator.on('event', (event) => renderEvent(event, config));

    // 7. Execute
    const result = await orchestrator.run(task, {
      mode: (options.mode as ExecutionMode) ?? config.mode,
      maxIterations: options.maxIterations,
      stream: options.stream,
    });

    // 8. Print summary
    printSessionSummary(result);

    db.close();
    process.exit(result.status === 'completed' ? 0 : 2);
  } catch (error) {
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}
