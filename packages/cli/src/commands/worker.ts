// packages/cli/src/commands/worker.ts — Background job worker that processes queued jobs

import {
  type CliAdapter,
  JobStore,
  ModelRegistry,
  REVIEW_DIFF_MAX_CHARS,
  buildHandoffEnvelope,
  loadConfig,
  openDatabase,
} from '@codemoot/core';
import chalk from 'chalk';
import { execSync } from 'node:child_process';

import { createProgressCallbacks } from '../progress.js';
import { getDbPath } from '../utils.js';

interface WorkerOptions {
  once: boolean;
  pollMs: number;
  workerId: string;
}

export async function workerCommand(options: WorkerOptions): Promise<void> {
  const projectDir = process.cwd();
  const db = openDatabase(getDbPath());
  const jobStore = new JobStore(db);
  const config = loadConfig();
  const registry = ModelRegistry.fromConfig(config, projectDir);
  const adapter =
    registry.tryGetAdapter('codex-reviewer') ?? registry.tryGetAdapter('codex-architect');
  if (!adapter) {
    try {
      execSync('codex --version', { stdio: 'pipe', encoding: 'utf-8' });
    } catch {
      console.error(chalk.red('Codex CLI is not installed or not in PATH.'));
      console.error(chalk.yellow('Install it: npm install -g @openai/codex'));
      db.close();
      process.exit(1);
    }
    console.error(chalk.red('No codex adapter found in config. Run: codemoot init'));
    db.close();
    process.exit(1);
  }

  const workerId = options.workerId;
  console.error(
    chalk.cyan(`Worker ${workerId} started (poll: ${options.pollMs}ms, once: ${options.once})`),
  );

  let running = true;
  const shutdown = () => {
    running = false;
    console.error(chalk.dim('\nWorker shutting down...'));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  while (running) {
    const job = jobStore.claimNext(workerId)[0];

    if (!job) {
      if (options.once) {
        console.error(chalk.dim('No jobs in queue. Exiting (--once mode).'));
        break;
      }
      await new Promise((r) => setTimeout(r, options.pollMs));
      continue;
    }

    console.error(chalk.cyan(`Processing job ${job.id} (type: ${job.type})`));
    jobStore.appendLog(job.id, 'info', 'job_started', `Worker ${workerId} claimed job`);

    try {
      const { resolve, normalize } = await import('node:path');
      const payload = JSON.parse(job.payloadJson) as Record<string, unknown>;
      const rawCwd = resolve((payload.path as string) ?? (payload.cwd as string) ?? projectDir);
      const cwd = normalize(rawCwd);
      // Prevent path traversal — resolved path must be within projectDir
      const sep = process.platform === 'win32' ? '\\' : '/';
      if (cwd !== normalize(projectDir) && !cwd.startsWith(normalize(projectDir) + sep)) {
        throw new Error(`Path traversal blocked: "${cwd}" is outside project directory "${projectDir}"`);
      }
      const timeout = ((payload.timeout as number) ?? 600) * 1000;

      let prompt: string;

      if (job.type === 'review' || job.type === 'watch-review') {
        const focus = (payload.focus as string) ?? 'all';
        const focusConstraint =
          focus === 'all'
            ? 'Review for: correctness, bugs, security, performance, code quality'
            : `Focus specifically on: ${focus}`;

        if (payload.prompt) {
          prompt = buildHandoffEnvelope({
            command: 'review',
            task: `TASK: ${payload.prompt}\n\nStart by listing candidate files, then inspect them thoroughly.`,
            constraints: [focusConstraint],
            resumed: false,
          });
        } else if (payload.diff) {
          const { execFileSync } = await import('node:child_process');
          // Validate diff args — only allow safe git ref patterns (no flag injection)
          const diffArgs = (payload.diff as string).split(/\s+/).filter(a => a.length > 0);
          for (const arg of diffArgs) {
            if (arg.startsWith('-') || !/^[a-zA-Z0-9_.~^:\/\\@{}]+$/.test(arg)) {
              throw new Error(`Invalid diff argument: "${arg}" — only git refs and paths allowed`);
            }
          }
          const diff = execFileSync('git', ['diff', ...diffArgs], {
            cwd,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024,
          });
          prompt = buildHandoffEnvelope({
            command: 'review',
            task: `Review these code changes.\n\nGIT DIFF:\n${diff.slice(0, REVIEW_DIFF_MAX_CHARS)}`,
            constraints: [focusConstraint],
            resumed: false,
          });
        } else if (payload.files && Array.isArray(payload.files)) {
          prompt = buildHandoffEnvelope({
            command: 'review',
            task: `Review these files: ${(payload.files as string[]).join(', ')}. Read each file and report issues.`,
            constraints: [focusConstraint],
            resumed: false,
          });
        } else {
          prompt = buildHandoffEnvelope({
            command: 'review',
            task: 'Review the codebase for issues. Start by listing key files.',
            constraints: [focusConstraint],
            resumed: false,
          });
        }
      } else if (job.type === 'cleanup') {
        prompt = buildHandoffEnvelope({
          command: 'cleanup',
          task: `Scan ${cwd} for: unused dependencies, dead code, duplicates, hardcoded values. Report findings with confidence levels.`,
          constraints: [`Scope: ${payload.scope ?? 'all'}`],
          resumed: false,
        });
      } else {
        jobStore.fail(job.id, `Unsupported job type: ${job.type}`);
        continue;
      }

      jobStore.appendLog(job.id, 'info', 'codex_started', 'Sending to codex...');
      const progress = createProgressCallbacks('worker');

      const result = await (adapter as CliAdapter).callWithResume(prompt, {
        timeout,
        ...progress,
      });

      jobStore.appendLog(
        job.id,
        'info',
        'codex_completed',
        `Received ${result.text.length} chars in ${result.durationMs}ms`,
      );

      // Store result
      const resultData: Record<string, unknown> = {
        text: result.text,
        usage: result.usage,
        durationMs: result.durationMs,
        sessionId: result.sessionId,
      };

      jobStore.succeed(job.id, resultData);
      console.error(chalk.green(`Job ${job.id} completed (${result.durationMs}ms)`));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      jobStore.appendLog(job.id, 'error', 'job_failed', errMsg);
      jobStore.fail(job.id, errMsg);
      console.error(chalk.red(`Job ${job.id} failed: ${errMsg}`));
    }

    if (options.once) break;
  }

  db.close();
  console.error(chalk.dim('Worker stopped.'));
}
