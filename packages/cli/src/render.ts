// packages/cli/src/render.ts — Terminal rendering for AG-UI events

import type { EngineEvent, ProjectConfig } from '@codemoot/core';
import chalk from 'chalk';
import ora from 'ora';

// Color scheme per role
const roleColors: Record<string, (text: string) => string> = {
  architect: chalk.blue,
  reviewer: chalk.yellow,
  implementer: chalk.green,
};

function getRoleColor(role: string): (text: string) => string {
  return roleColors[role] ?? chalk.white;
}

/**
 * Render a single AG-UI event to the terminal.
 */
export function renderEvent(event: EngineEvent, _config?: ProjectConfig): void {
  switch (event.type) {
    case 'session.started':
      console.log(chalk.gray(`\n━━━ Session ${event.sessionId} ━━━`));
      console.log(chalk.gray(`Workflow: ${event.workflow}`));
      console.log(chalk.gray(`Task: ${event.task}\n`));
      break;

    case 'session.completed':
      console.log(chalk.green('\n━━━ Session Complete ━━━'));
      console.log(chalk.cyan(`  Cost:     $${event.totalCost.toFixed(4)}`));
      console.log(chalk.cyan(`  Tokens:   ${event.totalTokens.toLocaleString()}`));
      console.log(chalk.cyan(`  Duration: ${(event.durationMs / 1000).toFixed(1)}s`));
      break;

    case 'session.failed':
      console.log(chalk.red('\n━━━ Session Failed ━━━'));
      console.log(chalk.red(`  Error: ${event.error}`));
      console.log(chalk.red(`  Last step: ${event.lastStep}`));
      break;

    case 'step.started': {
      const color = getRoleColor(event.role);
      console.log(
        color(`\n▶ [${event.role}] ${event.stepId} (${event.model}, iter ${event.iteration})`),
      );
      break;
    }

    case 'step.completed':
      console.log(
        chalk.gray(
          `  ✓ ${event.stepId} (${(event.durationMs / 1000).toFixed(1)}s, ${event.tokenUsage.totalTokens} tokens)`,
        ),
      );
      break;

    case 'step.failed':
      console.log(chalk.red(`  ✗ ${event.stepId}: ${event.error}`));
      break;

    case 'text.delta': {
      const deltaColor = getRoleColor(event.role);
      process.stdout.write(deltaColor(event.delta));
      break;
    }

    case 'text.done':
      process.stdout.write('\n');
      break;

    case 'loop.iteration': {
      const verdictColor = event.verdict === 'approved' ? chalk.green : chalk.yellow;
      console.log(
        verdictColor(`\n  ↻ Loop ${event.iteration}/${event.maxIterations}: ${event.verdict}`),
      );
      if (event.feedback) {
        console.log(chalk.gray(`    Feedback: ${event.feedback.slice(0, 200)}...`));
      }
      break;
    }

    case 'cost.update':
      console.log(
        chalk.cyan(
          `  $${event.costUsd.toFixed(4)} (cumulative: $${event.cumulativeSessionCost.toFixed(4)})`,
        ),
      );
      break;
  }
}

// Spinner helpers for step lifecycle
let activeSpinner: ReturnType<typeof ora> | null = null;

export function startStepSpinner(stepId: string, role: string, model: string): void {
  const color = getRoleColor(role);
  activeSpinner = ora({
    text: color(`${role} working on ${stepId} (${model})...`),
    color: role === 'architect' ? 'blue' : role === 'reviewer' ? 'yellow' : 'green',
  }).start();
}

export function stopStepSpinner(success: boolean): void {
  if (activeSpinner) {
    if (success) {
      activeSpinner.succeed();
    } else {
      activeSpinner.fail();
    }
    activeSpinner = null;
  }
}

/**
 * Print a final session summary with formatted output.
 */
export function printSessionSummary(result: {
  sessionId: string;
  status: string;
  totalCost: number;
  totalTokens: number;
  durationMs: number;
  iterations: number;
}): void {
  console.log(chalk.bold('\nSession Summary'));
  console.log(chalk.gray('-'.repeat(40)));
  console.log(`  Session:    ${chalk.white(result.sessionId)}`);
  console.log(
    `  Status:     ${result.status === 'completed' ? chalk.green('completed') : chalk.red(result.status)}`,
  );
  console.log(`  Cost:       ${chalk.cyan(`$${result.totalCost.toFixed(4)}`)}`);
  console.log(`  Tokens:     ${chalk.cyan(result.totalTokens.toLocaleString())}`);
  console.log(`  Duration:   ${chalk.cyan(`${(result.durationMs / 1000).toFixed(1)}s`)}`);
  console.log(`  Iterations: ${chalk.cyan(String(result.iterations))}`);
  console.log(chalk.gray('-'.repeat(40)));
}
