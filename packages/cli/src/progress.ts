// packages/cli/src/progress.ts — Shared progress callbacks for CLI commands

import type { ProgressCallbacks } from '@codemoot/core';
import chalk from 'chalk';

const THROTTLE_MS = 3_000;

/**
 * Create progress callbacks for CLI commands that show real-time
 * codex activity on stderr. Parses JSONL events to surface what
 * codex is actually doing (reading files, running tools, thinking).
 */
export function createProgressCallbacks(label = 'codex'): ProgressCallbacks {
  let lastActivityAt = 0;
  let lastMessage = '';
  let carryOver = '';

  function printActivity(msg: string) {
    const now = Date.now();
    // Dedupe identical messages and throttle
    if (msg === lastMessage && now - lastActivityAt < THROTTLE_MS) return;
    lastActivityAt = now;
    lastMessage = msg;
    console.error(chalk.dim(`  [${label}] ${msg}`));
  }

  return {
    onSpawn(pid: number, command: string) {
      console.error(chalk.dim(`  [${label}] Started (PID: ${pid}, cmd: ${command})`));
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

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          formatEvent(event, printActivity);
        } catch {
          // Not JSON — skip
        }
      }
    },

    onHeartbeat(elapsedSec: number) {
      // Only show heartbeats every 30s to reduce noise
      if (elapsedSec % 30 === 0) {
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

    if (item.type === 'agent_message') {
      const text = String(item.text ?? '');
      // Show first meaningful line of the response
      const firstLine = text.split('\n').find(l => l.trim().length > 10);
      if (firstLine) {
        const preview = firstLine.trim().slice(0, 80);
        print(`Response: ${preview}${firstLine.trim().length > 80 ? '...' : ''}`);
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
