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
  try {
    return await fn(db);
  } catch (error) {
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  } finally {
    db.close();
  }
}
