// packages/cli/src/commands/start.ts — First-run concierge: verify → init → quick review

import { existsSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join, basename } from 'node:path';
import chalk from 'chalk';
import { loadConfig, writeConfig, type PresetName } from '@codemoot/core';

export async function startCommand(): Promise<void> {
  const cwd = process.cwd();
  console.error(chalk.cyan('\n  CodeMoot — First Run Setup\n'));

  // Step 1: Verify Codex CLI
  console.error(chalk.dim('  [1/4] Checking Codex CLI...'));
  let codexVersion: string | null = null;
  try {
    codexVersion = execSync('codex --version', { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    // not installed
  }

  if (!codexVersion) {
    console.error(chalk.red('  Codex CLI is not installed.'));
    console.error(chalk.yellow('  Install it: npm install -g @openai/codex'));
    console.error(chalk.yellow('  Then run: codemoot start'));
    process.exit(1);
  }
  console.error(chalk.green(`  Codex CLI ${codexVersion} found.`));

  // Step 2: Check/create config
  console.error(chalk.dim('  [2/4] Checking project config...'));
  const configPath = join(cwd, '.cowork.yml');
  if (existsSync(configPath)) {
    console.error(chalk.green('  .cowork.yml exists — using it.'));
  } else {
    const config = loadConfig({ preset: 'cli-first' as PresetName, skipFile: true });
    config.project.name = basename(cwd);
    writeConfig(config, cwd);
    console.error(chalk.green('  Created .cowork.yml with cli-first preset.'));
  }

  // Step 3: Detect project type
  console.error(chalk.dim('  [3/4] Detecting project...'));
  const hasGit = existsSync(join(cwd, '.git'));
  const hasSrc = existsSync(join(cwd, 'src'));
  const hasPackageJson = existsSync(join(cwd, 'package.json'));

  let reviewTarget = '';
  if (hasGit) {
    try {
      const diff = execSync('git diff --name-only HEAD', { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (diff) {
        const files = diff.split('\n').filter(f => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.tsx') || f.endsWith('.jsx') || f.endsWith('.py'));
        if (files.length > 0) {
          reviewTarget = files.slice(0, 10).join(' ');
          console.error(chalk.green(`  Found ${files.length} changed file(s) — reviewing those.`));
        }
      }
    } catch {
      // no git diff available
    }
  }

  if (!reviewTarget) {
    if (hasSrc) {
      reviewTarget = 'src/';
      console.error(chalk.green('  Found src/ directory — reviewing it.'));
    } else if (hasPackageJson) {
      reviewTarget = '**/*.ts';
      console.error(chalk.green('  TypeScript project — reviewing *.ts files.'));
    } else {
      console.error(chalk.yellow('  No src/ or package.json found. Try: codemoot review <path>'));
      process.exit(0);
    }
  }

  // Step 4: Run quick review
  console.error(chalk.dim('  [4/4] Running quick review...'));
  console.error(chalk.cyan(`\n  codemoot review ${reviewTarget} --preset quick-scan\n`));

  try {
    const output = execFileSync('codemoot', ['review', reviewTarget, '--preset', 'quick-scan'], {
      cwd,
      encoding: 'utf-8',
      timeout: 300000,
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    });

    // Parse and display summary
    try {
      const result = JSON.parse(output);
      const findingCount = result.findings?.length ?? 0;
      const verdict = result.verdict ?? 'unknown';
      const score = result.score;

      console.error('');
      if (findingCount > 0) {
        console.error(chalk.yellow(`  Found ${findingCount} issue(s). Score: ${score ?? '?'}/10`));
        console.error('');
        console.error(chalk.cyan('  Next steps:'));
        console.error(chalk.dim(`    codemoot fix ${reviewTarget} --dry-run   # preview fixes`));
        console.error(chalk.dim(`    codemoot fix ${reviewTarget}             # apply fixes`));
        console.error(chalk.dim('    codemoot review --preset security-audit  # deeper scan'));
      } else if (verdict === 'approved') {
        console.error(chalk.green(`  Code looks good! Score: ${score ?? '?'}/10`));
        console.error('');
        console.error(chalk.cyan('  Next steps:'));
        console.error(chalk.dim('    codemoot review --preset security-audit  # security scan'));
        console.error(chalk.dim('    codemoot debate start "your question"    # debate with GPT'));
        console.error(chalk.dim('    codemoot watch                           # watch for changes'));
      } else {
        console.error(chalk.dim(`  Review complete. Verdict: ${verdict}, Score: ${score ?? '?'}/10`));
      }
    } catch {
      // Raw output if not JSON
      console.log(output);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) {
      console.error(chalk.yellow('  Review timed out. Try: codemoot review --preset quick-scan'));
    } else {
      console.error(chalk.red(`  Review failed: ${msg.slice(0, 200)}`));
    }
  }

  console.error(chalk.dim('  Tip: Run codemoot install-skills to add /debate, /build, /cleanup'));
  console.error(chalk.dim('  slash commands to Claude Code in this project.'));
  console.error('');
}
