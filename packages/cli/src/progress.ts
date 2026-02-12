// packages/cli/src/progress.ts — Shared progress callbacks for CLI commands

import type { ProgressCallbacks } from '@codemoot/core';
import chalk from 'chalk';

const THROTTLE_MS = 30_000;
const MAX_CARRY_OVER = 64 * 1024; // 64KB — prevent unbounded buffer growth

/**
 * Create progress callbacks for CLI commands that show real-time
 * codex activity on stderr. Parses JSONL events to surface what
 * codex is actually doing (reading files, running tools, thinking).
 */
export function createProgressCallbacks(label = 'codex'): ProgressCallbacks {
  let lastActivityAt = 0;
  let lastMessage = '';
  let carryOver = '';
  let droppedEvents = 0;

  function printActivity(msg: string) {
    const now = Date.now();
    // Dedupe identical messages and throttle
    if (msg === lastMessage && now - lastActivityAt < THROTTLE_MS) return;
    lastActivityAt = now;
    lastMessage = msg;
    console.error(chalk.dim(`  [${label}] ${msg}`));
  }

  function parseLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed);
      formatEvent(event, printActivity);
    } catch {
      droppedEvents++;
    }
  }

  return {
    onSpawn(pid: number, command: string) {
      // Redact args to avoid leaking tokens/credentials in logs — keep only basename
      const exe = command.replace(/^"([^"]+)".*/, '$1').split(/[\s/\\]+/).pop() ?? command;
      console.error(chalk.dim(`  [${label}] Started (PID: ${pid}, cmd: ${exe})`));
    },

    onStderr(_chunk: string) {
      // Codex stderr is mostly internal noise — skip
    },

    onProgress(chunk: string) {
      // Parse JSONL events from codex stdout — handle lines split across chunks
      const data = carryOver + chunk;
      const lines = data.split('\n');
      // Last element may be incomplete — carry it over to next chunk
      carryOver = lines.pop() ?? '';

      // Cap carryOver to prevent unbounded memory growth on malformed streams
      if (carryOver.length > MAX_CARRY_OVER) {
        carryOver = '';
        droppedEvents++;
      }

      for (const line of lines) {
        parseLine(line);
      }
    },

    onClose() {
      // Flush remaining carryOver on stream end (final event without trailing newline)
      if (carryOver.trim()) {
        parseLine(carryOver);
        carryOver = '';
      }
      if (droppedEvents > 0) {
        console.error(chalk.dim(`  [${label}] ${droppedEvents} event(s) dropped (parse errors or buffer overflow)`));
        droppedEvents = 0;
      }
    },

    onHeartbeat(elapsedSec: number) {
      // Show heartbeats every 60s to reduce noise
      if (elapsedSec % 60 === 0) {
        printActivity(`${elapsedSec}s elapsed...`);
      }
    },
  };
}

/** Extract a human-readable summary from a codex JSONL event. */
function formatEvent(
  event: Record<string, unknown>,
  print: (msg: string) => void,
): void {
  const type = event.type as string;

  if (type === 'thread.started') {
    const tid = (event.thread_id as string) ?? '';
    print(`Thread: ${tid.slice(0, 12)}...`);
    return;
  }

  // Tool calls — show which tool codex is invoking
  if (type === 'item.completed') {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return;

    if (item.type === 'tool_call' || item.type === 'function_call') {
      const name = (item.name as string) ?? (item.function as string) ?? 'tool';
      const rawArgs = item.arguments ?? item.input ?? '';
      const args = (typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs)).slice(0, 80);
      // Extract file paths from tool args for readability
      const pathMatch = args.match(/["']([^"']*\.[a-z]{1,4})["']/i);
      if (pathMatch) {
        print(`${name}: ${pathMatch[1]}`);
      } else {
        print(`${name}${args ? `: ${args.slice(0, 60)}` : ''}`);
      }
      return;
    }
  }

  if (type === 'turn.completed') {
    const usage = event.usage as Record<string, number> | undefined;
    if (usage) {
      const input = (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
      const output = usage.output_tokens ?? 0;
      print(`Turn done (${input} in / ${output} out tokens)`);
    }
    return;
  }
}
