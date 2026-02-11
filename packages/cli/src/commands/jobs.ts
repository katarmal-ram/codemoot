// packages/cli/src/commands/jobs.ts — Background job queue CLI commands

import { JobStore, openDatabase } from '@codemoot/core';
import type { JobStatus, JobType } from '@codemoot/core';
import chalk from 'chalk';

import { getDbPath } from '../utils.js';

// ── codemoot jobs list ──

interface ListOptions {
  status?: string;
  type?: string;
  limit?: number;
}

export async function jobsListCommand(options: ListOptions): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(getDbPath());
    const store = new JobStore(db);

    const jobs = store.list({
      status: options.status as JobStatus | undefined,
      type: options.type as JobType | undefined,
      limit: options.limit ?? 20,
    });

    const output = jobs.map(j => ({
      id: j.id,
      type: j.type,
      status: j.status,
      priority: j.priority,
      retryCount: j.retryCount,
      workerId: j.workerId,
      createdAt: new Date(j.createdAt).toISOString(),
      startedAt: j.startedAt ? new Date(j.startedAt).toISOString() : null,
      finishedAt: j.finishedAt ? new Date(j.finishedAt).toISOString() : null,
    }));

    console.log(JSON.stringify(output, null, 2));
    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot jobs logs ──

interface LogsOptions {
  fromSeq?: number;
  limit?: number;
}

export async function jobsLogsCommand(jobId: string, options: LogsOptions): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(getDbPath());
    const store = new JobStore(db);

    const job = store.get(jobId);
    if (!job) {
      console.error(chalk.red(`No job found with ID: ${jobId}`));
      db.close();
      process.exit(1);
    }

    const logs = store.getLogs(jobId, options.fromSeq ?? 0, options.limit ?? 100);

    const output = {
      jobId: job.id,
      type: job.type,
      status: job.status,
      logs: logs.map(l => ({
        seq: l.seq,
        level: l.level,
        event: l.eventType,
        message: l.message,
        time: new Date(l.createdAt).toISOString(),
      })),
    };

    console.log(JSON.stringify(output, null, 2));
    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot jobs cancel ──

export async function jobsCancelCommand(jobId: string): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(getDbPath());
    const store = new JobStore(db);

    const job = store.get(jobId);
    if (!job) {
      console.error(chalk.red(`No job found with ID: ${jobId}`));
      db.close();
      process.exit(1);
    }

    store.cancel(jobId);
    console.log(JSON.stringify({ jobId, status: 'canceled' }));
    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot jobs retry ──

export async function jobsRetryCommand(jobId: string): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(getDbPath());
    const store = new JobStore(db);

    const job = store.get(jobId);
    if (!job) {
      console.error(chalk.red(`No job found with ID: ${jobId}`));
      db.close();
      process.exit(1);
    }

    const retried = store.retry(jobId);
    if (!retried) {
      console.error(chalk.red(`Cannot retry job ${jobId}: status=${job.status}, retries=${job.retryCount}/${job.maxRetries}`));
      db.close();
      process.exit(1);
    }

    console.log(JSON.stringify({ jobId, status: 'queued', retryCount: job.retryCount + 1 }));
    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── codemoot jobs status ──

export async function jobsStatusCommand(jobId: string): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    db = openDatabase(getDbPath());
    const store = new JobStore(db);

    const job = store.get(jobId);
    if (!job) {
      console.error(chalk.red(`No job found with ID: ${jobId}`));
      db.close();
      process.exit(1);
    }

    const logs = store.getLogs(jobId, 0, 5);

    const output = {
      id: job.id,
      type: job.type,
      status: job.status,
      priority: job.priority,
      retryCount: job.retryCount,
      maxRetries: job.maxRetries,
      workerId: job.workerId,
      sessionId: job.sessionId,
      payload: JSON.parse(job.payloadJson),
      result: job.resultJson ? JSON.parse(job.resultJson) : null,
      error: job.errorText,
      recentLogs: logs.map(l => ({
        seq: l.seq,
        level: l.level,
        event: l.eventType,
        message: l.message,
      })),
      createdAt: new Date(job.createdAt).toISOString(),
      startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    };

    console.log(JSON.stringify(output, null, 2));
    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}
