// packages/cli/src/commands/cost.ts — Cost and usage dashboard

import { openDatabase, SessionManager } from '@codemoot/core';
import chalk from 'chalk';

import { getDbPath } from '../utils.js';

interface CostOptions {
  scope: string;
  days: number;
  session?: string;
}

interface UsageRow {
  command: string;
  subcommand: string;
  usage_json: string;
  duration_ms: number;
  created_at: number;
}

function parseUsage(usageJson: string): { input: number; output: number; total: number } {
  try {
    const u = JSON.parse(usageJson);
    const input = u.inputTokens ?? u.input_tokens ?? 0;
    const output = u.outputTokens ?? u.output_tokens ?? 0;
    const total = u.totalTokens ?? u.total_tokens ?? input + output;
    return { input, output, total };
  } catch {
    return { input: 0, output: 0, total: 0 };
  }
}

export async function costCommand(options: CostOptions): Promise<void> {
  const db = openDatabase(getDbPath());

  try {
    let rows: UsageRow[];
    let scopeLabel: string;

    if (options.scope === 'session') {
      const sessionMgr = new SessionManager(db);
      const session = options.session
        ? sessionMgr.get(options.session)
        : sessionMgr.resolveActive('cost');
      if (!session) {
        console.error(chalk.red(options.session ? `Session not found: ${options.session}` : 'No active session. Run: codemoot init'));
        db.close();
        process.exit(1);
      }
      rows = db
        .prepare(
          'SELECT command, subcommand, usage_json, duration_ms, created_at FROM session_events WHERE session_id = ? ORDER BY created_at ASC',
        )
        .all(session.id) as UsageRow[];
      scopeLabel = `session ${session.id.slice(0, 8)}`;
    } else if (options.scope === 'all') {
      rows = db
        .prepare(
          'SELECT command, subcommand, usage_json, duration_ms, created_at FROM session_events ORDER BY created_at ASC',
        )
        .all() as UsageRow[];
      scopeLabel = 'all-time';
    } else {
      const cutoff = Date.now() - options.days * 24 * 60 * 60 * 1000;
      rows = db
        .prepare(
          'SELECT command, subcommand, usage_json, duration_ms, created_at FROM session_events WHERE created_at > ? ORDER BY created_at ASC',
        )
        .all(cutoff) as UsageRow[];
      scopeLabel = `last ${options.days} days`;
    }

    let totalInput = 0;
    let totalOutput = 0;
    let totalTokens = 0;
    let totalDuration = 0;
    const byCommand: Record<string, { calls: number; tokens: number; durationMs: number }> = {};
    const byDay: Record<string, { calls: number; tokens: number }> = {};

    for (const row of rows) {
      const usage = parseUsage(row.usage_json);
      totalInput += usage.input;
      totalOutput += usage.output;
      totalTokens += usage.total;
      totalDuration += row.duration_ms ?? 0;

      const cmd = row.command ?? 'unknown';
      if (!byCommand[cmd]) byCommand[cmd] = { calls: 0, tokens: 0, durationMs: 0 };
      byCommand[cmd].calls++;
      byCommand[cmd].tokens += usage.total;
      byCommand[cmd].durationMs += row.duration_ms ?? 0;

      const day = new Date(row.created_at).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { calls: 0, tokens: 0 };
      byDay[day].calls++;
      byDay[day].tokens += usage.total;
    }

    const output = {
      scope: scopeLabel,
      totalCalls: rows.length,
      totalTokens,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalDurationMs: totalDuration,
      avgTokensPerCall: rows.length > 0 ? Math.round(totalTokens / rows.length) : 0,
      avgDurationMs: rows.length > 0 ? Math.round(totalDuration / rows.length) : 0,
      byCommand,
      byDay,
    };

    console.log(JSON.stringify(output, null, 2));
    db.close();
  } catch (error) {
    db.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}
