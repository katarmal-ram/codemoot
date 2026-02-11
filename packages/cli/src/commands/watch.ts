// packages/cli/src/commands/watch.ts — File watcher that enqueues review jobs on change

import { JobStore, openDatabase } from '@codemoot/core';
import chalk from 'chalk';
import { watch } from 'chokidar';

import { getDbPath } from '../utils.js';
import { Debouncer } from '../watch/debouncer.js';

interface WatchOptions {
  glob: string;
  focus: string;
  timeout: number;
  quietMs: number;
  maxWaitMs: number;
  cooldownMs: number;
}

export async function watchCommand(options: WatchOptions): Promise<void> {
  const projectDir = process.cwd();
  const db = openDatabase(getDbPath());
  const jobStore = new JobStore(db);

  const debouncer = new Debouncer(
    (batch) => {
      // Dedupe: skip if a watch-review job is already queued for same scope
      const dedupeKey = `watch-review:${batch.files.sort().join(',')}`.slice(0, 255);
      if (jobStore.hasActiveByType('watch-review')) {
        console.error(
          chalk.yellow(`  Skipping batch ${batch.batchId} — watch-review already queued/running`),
        );
        return;
      }

      const jobId = jobStore.enqueue({
        type: 'watch-review',
        payload: {
          files: batch.files,
          focus: options.focus,
          timeout: options.timeout,
          cwd: projectDir,
          batchId: batch.batchId,
          reason: batch.reason,
        },
        dedupeKey,
      });

      const event = {
        type: 'watch_batch',
        jobId,
        batchId: batch.batchId,
        files: batch.files.length,
        reason: batch.reason,
        ts: new Date().toISOString(),
      };
      console.log(JSON.stringify(event));
    },
    {
      quietMs: options.quietMs,
      maxWaitMs: options.maxWaitMs,
      cooldownMs: options.cooldownMs,
    },
  );

  const ignored = [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/.cowork/**',
    '**/coverage/**',
    '**/*.db',
    '**/*.db-journal',
    '**/*.db-wal',
  ];

  console.error(chalk.cyan(`Watching ${options.glob} for changes...`));
  console.error(
    chalk.dim(
      `  quiet=${options.quietMs}ms, maxWait=${options.maxWaitMs}ms, cooldown=${options.cooldownMs}ms`,
    ),
  );

  const watcher = watch(options.glob, {
    cwd: projectDir,
    ignored,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  watcher.on('all', (event, path) => {
    if (event === 'add' || event === 'change' || event === 'unlink') {
      debouncer.push({ path, event, ts: Date.now() });
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.error(chalk.dim('\nShutting down watcher...'));
    debouncer.flushNow();
    debouncer.destroy();
    watcher.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
