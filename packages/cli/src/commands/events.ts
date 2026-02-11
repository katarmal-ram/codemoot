// packages/cli/src/commands/events.ts — Tail session events + job logs as JSONL

import { openDatabase } from '@codemoot/core';
import chalk from 'chalk';

import { getDbPath } from '../utils.js';

interface EventsOptions {
  follow: boolean;
  sinceSeq: number;
  limit: number;
  type: string;
}

export async function eventsCommand(options: EventsOptions): Promise<void> {
  const db = openDatabase(getDbPath());

  const query =
    options.type === 'all'
      ? db.prepare(`
        SELECT 'session_event' as source, id, session_id, command, subcommand, prompt_preview, response_preview, usage_json, duration_ms, created_at
        FROM session_events
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?
      `)
      : options.type === 'jobs'
        ? db.prepare(`
          SELECT 'job_log' as source, id, job_id, seq, level, event_type, message, payload_json, created_at
          FROM job_logs
          WHERE id > ?
          ORDER BY id ASC
          LIMIT ?
        `)
        : db.prepare(`
          SELECT 'session_event' as source, id, session_id, command, subcommand, prompt_preview, response_preview, usage_json, duration_ms, created_at
          FROM session_events
          WHERE id > ?
          ORDER BY id ASC
          LIMIT ?
        `);

  let cursor = options.sinceSeq;

  const poll = () => {
    const rows = query.all(cursor, options.limit) as Record<string, unknown>[];
    for (const row of rows) {
      console.log(JSON.stringify(row));
      cursor = row.id as number;
    }
    return rows.length;
  };

  // Initial dump
  poll();

  if (!options.follow) {
    db.close();
    return;
  }

  // Follow mode: poll every 1s
  console.error(chalk.dim('Following events... (Ctrl+C to stop)'));

  const interval = setInterval(() => {
    poll();
  }, 1000);

  const shutdown = () => {
    clearInterval(interval);
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
