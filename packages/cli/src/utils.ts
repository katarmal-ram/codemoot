import { openDatabase } from '@codemoot/core';
import chalk from 'chalk';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function getDbPath(projectDir?: string): string {
  const base = projectDir ?? process.cwd();
  const dbDir = join(base, '.cowork', 'db');
  mkdirSync(dbDir, { recursive: true });
  return join(dbDir, 'cowork.db');
}

/**
 * Run a command function with a database connection that is guaranteed to close,
 * even on errors or process.exit calls.
 */
export async function withDatabase<T>(fn: (db: ReturnType<typeof openDatabase>) => Promise<T>): Promise<T> {
  const db = openDatabase(getDbPath());
  const originalExit = process.exit;
  let requestedExitCode: number | undefined;

  process.exit = ((code?: number) => {
    requestedExitCode = typeof code === 'number' ? code : 1;
    throw new Error('__WITH_DATABASE_EXIT__');
  }) as typeof process.exit;

  try {
    return await fn(db);
  } catch (error) {
    if (requestedExitCode === undefined) {
      console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    }
    throw error;
  } finally {
    process.exit = originalExit;
    db.close();
    if (requestedExitCode !== undefined) {
      originalExit(requestedExitCode);
    }
  }
}
