// packages/cli/src/commands/doctor.ts — Preflight diagnostics for CodeMoot

import { existsSync, accessSync, constants } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import chalk from 'chalk';
import { VERSION } from '@codemoot/core';

interface Check {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

export async function doctorCommand(): Promise<void> {
  const cwd = process.cwd();
  const checks: Check[] = [];

  console.error(chalk.cyan(`\n  CodeMoot Doctor v${VERSION}\n`));

  // 1. Codex CLI
  try {
    const version = execSync('codex --version', { stdio: 'pipe', encoding: 'utf-8' }).trim();
    checks.push({ name: 'codex-cli', status: 'pass', message: `Codex CLI ${version}` });
  } catch {
    checks.push({
      name: 'codex-cli',
      status: 'fail',
      message: 'Codex CLI not found in PATH',
      fix: 'npm install -g @openai/codex',
    });
  }

  // 2. Config file
  const configPath = join(cwd, '.cowork.yml');
  if (existsSync(configPath)) {
    checks.push({ name: 'config', status: 'pass', message: '.cowork.yml found' });
  } else {
    checks.push({
      name: 'config',
      status: 'fail',
      message: '.cowork.yml not found',
      fix: 'codemoot init',
    });
  }

  // 3. Database writable
  const dbDir = join(cwd, '.cowork', 'db');
  const dbPath = join(dbDir, 'cowork.db');
  if (existsSync(dbDir)) {
    try {
      accessSync(dbDir, constants.W_OK);
      checks.push({
        name: 'database',
        status: existsSync(dbPath) ? 'pass' : 'warn',
        message: existsSync(dbPath) ? 'Database exists and writable' : 'Database directory exists, DB will be created on first use',
      });
    } catch {
      checks.push({
        name: 'database',
        status: 'fail',
        message: '.cowork/db/ is not writable',
        fix: 'Check file permissions on .cowork/db/',
      });
    }
  } else {
    checks.push({
      name: 'database',
      status: 'warn',
      message: '.cowork/db/ not found — will be created by codemoot init',
      fix: 'codemoot init',
    });
  }

  // 4. Git repo — traverse up to find .git
  let gitFound = false;
  let searchDir = cwd;
  while (searchDir) {
    if (existsSync(join(searchDir, '.git'))) {
      gitFound = true;
      break;
    }
    const parent = join(searchDir, '..');
    if (parent === searchDir) break;
    searchDir = parent;
  }
  if (gitFound) {
    checks.push({ name: 'git', status: 'pass', message: 'Git repository detected' });
  } else {
    checks.push({
      name: 'git',
      status: 'warn',
      message: 'Not a git repository — diff/shipit/watch features limited',
    });
  }

  // 5. Node version
  const nodeVersion = process.version;
  const major = Number.parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (major >= 18) {
    checks.push({ name: 'node', status: 'pass', message: `Node.js ${nodeVersion}` });
  } else {
    checks.push({
      name: 'node',
      status: 'fail',
      message: `Node.js ${nodeVersion} — requires >= 18`,
      fix: 'Install Node.js 18+',
    });
  }

  // 6. Schema version check
  if (existsSync(dbPath)) {
    try {
      const { openDatabase } = await import('@codemoot/core');
      const db = openDatabase(dbPath);
      const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
      const version = row?.user_version ?? 0;
      if (version >= 7) {
        checks.push({ name: 'schema', status: 'pass', message: `Schema version ${version}` });
      } else {
        checks.push({
          name: 'schema',
          status: 'warn',
          message: `Schema version ${version} — will auto-migrate on next command`,
        });
      }
      db.close();
    } catch {
      checks.push({ name: 'schema', status: 'warn', message: 'Could not read schema version' });
    }
  }

  // Print results
  let hasFailure = false;
  for (const check of checks) {
    const icon = check.status === 'pass'
      ? chalk.green('PASS')
      : check.status === 'warn'
        ? chalk.yellow('WARN')
        : chalk.red('FAIL');
    console.error(`  ${icon} ${check.name}: ${check.message}`);
    if (check.fix) {
      console.error(chalk.dim(`       → ${check.fix}`));
    }
    if (check.status === 'fail') hasFailure = true;
  }

  console.error('');

  // JSON output
  const output = {
    version: VERSION,
    checks,
    healthy: !hasFailure,
  };
  console.log(JSON.stringify(output, null, 2));

  if (hasFailure) {
    process.exit(1);
  }
}
