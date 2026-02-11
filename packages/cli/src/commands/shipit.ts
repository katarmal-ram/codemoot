// packages/cli/src/commands/shipit.ts — Composite workflow profiles

import { execSync } from 'node:child_process';
import { DEFAULT_RULES, type PolicyContext, evaluatePolicy } from '@codemoot/core';
import chalk from 'chalk';

interface ShipitOptions {
  profile: string;
  dryRun: boolean;
  noCommit: boolean;
  json: boolean;
  strictOutput: boolean;
}

interface StepResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  output?: string;
  durationMs: number;
}

const PROFILES: Record<string, string[]> = {
  fast: ['review'],
  safe: ['lint', 'test', 'review', 'cleanup'],
  full: ['lint', 'test', 'review', 'cleanup', 'commit'],
};

function runStep(name: string, dryRun: boolean): StepResult {
  const start = Date.now();
  if (dryRun) {
    return { name, status: 'skipped', output: 'dry-run', durationMs: 0 };
  }

  try {
    let cmd: string;
    switch (name) {
      case 'lint':
        cmd = 'npx biome check .';
        break;
      case 'test':
        cmd = 'pnpm run test';
        break;
      case 'review':
        cmd = 'codemoot review --preset pre-commit --diff HEAD';
        break;
      case 'cleanup':
        cmd = 'codemoot cleanup --scope deps';
        break;
      case 'commit':
        return { name, status: 'skipped', output: 'handled by shipit', durationMs: 0 };
      default:
        return { name, status: 'skipped', output: `unknown step: ${name}`, durationMs: 0 };
    }

    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: 300000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      name,
      status: 'passed',
      output: output.slice(0, 2000),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'failed', output: msg.slice(0, 2000), durationMs: Date.now() - start };
  }
}

export async function shipitCommand(options: ShipitOptions): Promise<void> {
  const profile = options.profile;
  const steps = PROFILES[profile];

  if (!steps) {
    console.error(chalk.red(`Unknown profile: ${profile}. Use: fast, safe, full`));
    process.exit(1);
  }

  if (options.dryRun) {
    console.error(chalk.cyan(`Shipit dry-run (profile: ${profile})`));
    console.error(chalk.dim(`Steps: ${steps.join(' → ')}`));
  } else {
    console.error(chalk.cyan(`Shipit (profile: ${profile}): ${steps.join(' → ')}`));
  }

  const results: StepResult[] = [];
  let shouldStop = false;

  for (const step of steps) {
    if (shouldStop) {
      results.push({ name: step, status: 'skipped', durationMs: 0 });
      continue;
    }

    const result = runStep(step, options.dryRun);
    results.push(result);

    if (!options.dryRun) {
      const icon =
        result.status === 'passed'
          ? chalk.green('OK')
          : result.status === 'failed'
            ? chalk.red('FAIL')
            : chalk.dim('SKIP');
      console.error(`  ${icon} ${result.name} (${result.durationMs}ms)`);
    }

    if (result.status === 'failed' && (step === 'lint' || step === 'test')) {
      shouldStop = true;
    }
  }

  // Policy evaluation
  const reviewResult = results.find((r) => r.name === 'review');
  const criticalCount = reviewResult?.output?.match(/CRITICAL/gi)?.length ?? 0;
  const warningCount = reviewResult?.output?.match(/WARNING/gi)?.length ?? 0;
  const verdictMatch = reviewResult?.output?.match(/VERDICT:\s*(APPROVED|NEEDS_REVISION)/i);

  const policyCtx: PolicyContext = {
    criticalCount,
    warningCount,
    verdict: verdictMatch ? verdictMatch[1].toLowerCase() : 'unknown',
    stepsCompleted: Object.fromEntries(results.map((r) => [r.name, r.status])),
    cleanupHighCount: 0,
  };

  const policyResult = evaluatePolicy('review.completed', policyCtx, DEFAULT_RULES);

  if (policyResult.decision === 'block') {
    console.error(chalk.red('Policy BLOCKED:'));
    for (const v of policyResult.violations) {
      console.error(chalk.red(`  - ${v.message}`));
    }
  } else if (policyResult.decision === 'warn') {
    for (const v of policyResult.violations) {
      console.error(chalk.yellow(`  Warning: ${v.message}`));
    }
  }

  const output = {
    profile,
    steps: results,
    policy: policyResult,
    canCommit: policyResult.decision !== 'block' && !shouldStop && !options.noCommit,
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    const allPassed = results.every((r) => r.status === 'passed' || r.status === 'skipped');
    if (allPassed && policyResult.decision !== 'block') {
      console.error(chalk.green('\nAll checks passed. Ready to commit.'));
    } else {
      console.error(chalk.red('\nSome checks failed or policy blocked.'));
    }
  }
}
