// packages/core/src/models/cli-adapter.ts — CLI subprocess adapter for free model access

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProvider } from '../types/config.js';
import type { TokenUsage } from '../types/events.js';
import type { ModelCallResult } from '../types/models.js';
import { ModelError } from '../utils/errors.js';
import type { BridgeCapabilities, CliBridge } from './bridge.js';

const MAX_OUTPUT_BYTES = 512 * 1024; // 512KB
const TRUNCATION_MARKER = '\n[TRUNCATED: output exceeded 512KB]';

// Default env vars always passed to CLI subprocesses
const BASE_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'SystemRoot',
  'COMSPEC',
  'SHELL',
];

// CLI-specific auth env vars
const CLI_AUTH_VARS: Record<string, string[]> = {
  codex: ['OPENAI_API_KEY'],
};

/** Progress callbacks for real-time feedback during CLI subprocess execution. */
export interface ProgressCallbacks {
  /** Called when the subprocess successfully spawns. */
  onSpawn?: (pid: number, command: string) => void;
  /** Called on each stderr chunk (tool calls, activity). */
  onStderr?: (chunk: string) => void;
  /** Called periodically (every 15s) with elapsed seconds. */
  onHeartbeat?: (elapsedSec: number) => void;
  /** Called on each stdout chunk for progress feedback. */
  onProgress?: (chunk: string) => void;
  /** Called when the subprocess closes — flush any buffered state. */
  onClose?: () => void;
}

export interface CliCallOptions extends ProgressCallbacks {
  /** Total timeout in ms. Default: 600_000 (10 min). */
  timeout?: number;
  /** Inactivity timeout — kill if no stdout for this long. Default: 120_000 (2 min). */
  idleTimeout?: number;
  maxOutputBytes?: number;
  envAllowlist?: string[];
}

export interface ResumeCallOptions extends CliCallOptions {
  /** Codex thread_id to resume a conversation. */
  sessionId?: string;
}

/** Known context windows by model family. GPT-5 codex models have 400K. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5-codex': 400_000,
  'gpt-5.1-codex': 400_000,
  'gpt-5.2-codex': 400_000,
  'gpt-5.3-codex': 400_000,
  'codex-mini-latest': 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 400_000;

/** Default capabilities for codex CLI bridge. */
const CODEX_CAPABILITIES: BridgeCapabilities = {
  supportsResume: true,
  supportsStream: true,
  maxContextTokens: DEFAULT_CONTEXT_WINDOW,
  supportsTools: true,
  supportsCwd: true,
};

export class CliAdapter implements CliBridge {
  private command: string;
  private baseArgs: string[];
  private provider: ModelProvider;
  readonly modelId: string;
  private cliName: string;
  private projectDir: string | undefined;
  readonly capabilities: BridgeCapabilities;

  get name(): string { return this.cliName; }
  get model(): string { return this.modelId; }

  constructor(config: {
    command: string;
    args: string[];
    provider: ModelProvider;
    model: string;
    cliName: string;
    projectDir?: string;
  }) {
    this.command = config.command;
    this.baseArgs = config.args;
    this.provider = config.provider;
    this.modelId = config.model;
    this.cliName = config.cliName;
    this.projectDir = config.projectDir;
    this.capabilities = {
      ...CODEX_CAPABILITIES,
      maxContextTokens: MODEL_CONTEXT_WINDOWS[config.model] ?? DEFAULT_CONTEXT_WINDOW,
    };
  }

  /** CliBridge.send — send a prompt without session resume. */
  async send(prompt: string, options?: CliCallOptions): Promise<ModelCallResult> {
    return this.call(prompt, options);
  }

  /** CliBridge.resume — resume a session or fall back to send. */
  async resume(sessionId: string, prompt: string, options?: CliCallOptions): Promise<ModelCallResult> {
    if (!this.capabilities.supportsResume) {
      return this.send(prompt, options);
    }
    return this.callWithResume(prompt, { ...options, sessionId });
  }

  async call(prompt: string, options?: CliCallOptions): Promise<ModelCallResult> {
    const timeout = options?.timeout ?? 600_000;
    const maxBytes = options?.maxOutputBytes ?? MAX_OUTPUT_BYTES;

    // Build filtered env
    const allowlist = [
      ...BASE_ENV_ALLOWLIST,
      ...(CLI_AUTH_VARS[this.cliName] ?? []),
      ...(options?.envAllowlist ?? []),
    ];
    const env = buildFilteredEnv(allowlist);

    // Create temp output file
    const tmpFile = join(tmpdir(), `codemoot-cli-${randomUUID()}.txt`);

    // Build command args (prompt piped via stdin, not as CLI arg)
    const args = this.buildArgs(tmpFile);
    const start = Date.now();

    try {
      await this.runProcess(this.command, args, env, timeout, prompt, {
        idleTimeout: options?.idleTimeout,
        onProgress: options?.onProgress,
        onSpawn: options?.onSpawn,
        onStderr: options?.onStderr,
        onHeartbeat: options?.onHeartbeat,
      });

      // Codex writes to tmpFile via -o flag
      let output = await readFile(tmpFile, 'utf-8');

      if (Buffer.byteLength(output) > maxBytes) {
        output = Buffer.from(output).subarray(0, maxBytes).toString('utf-8') + TRUNCATION_MARKER;
      }

      const durationMs = Date.now() - start;
      const usage = estimateTokenUsage(prompt, output);

      return {
        text: output,
        model: this.modelId,
        provider: this.provider,
        usage,
        finishReason: 'stop',
        durationMs,
      };
    } finally {
      // Cleanup temp file
      await unlink(tmpFile).catch(() => {});
    }
  }

  /**
   * Call codex with session resume support via --json JSONL output.
   * If sessionId is provided, resumes the conversation. On resume failure,
   * falls back to a fresh exec and returns the new sessionId.
   */
  async callWithResume(prompt: string, options?: ResumeCallOptions): Promise<ModelCallResult> {
    const timeout = options?.timeout ?? 600_000;
    const maxBytes = options?.maxOutputBytes ?? MAX_OUTPUT_BYTES;

    const allowlist = [
      ...BASE_ENV_ALLOWLIST,
      ...(CLI_AUTH_VARS[this.cliName] ?? []),
      ...(options?.envAllowlist ?? []),
    ];
    const env = buildFilteredEnv(allowlist);

    const doCall = async (resumeId?: string): Promise<ModelCallResult> => {
      const ext = process.platform === 'win32' ? '.cmd' : '';

      // Always use stdin ("-") for prompt delivery:
      // - Fresh exec: stdin is the default prompt source
      // - Resume: positional arg breaks on Windows shell:true (spaces split into multiple args)
      //   Using "-" tells codex to read the prompt from stdin instead
      // Build args: if we have a project dir, tell codex about it via --cd
      const cdArgs = this.projectDir ? ['-C', this.projectDir] : [];
      const args = resumeId
        ? ['exec', '--skip-git-repo-check', ...cdArgs, 'resume', resumeId, '-', '--json']
        : ['exec', '--skip-git-repo-check', ...cdArgs, '--json'];

      const start = Date.now();
      const stdout = await this.runProcess(`codex${ext}`, args, env, timeout, prompt, {
        idleTimeout: options?.idleTimeout,
        onProgress: options?.onProgress,
        onSpawn: options?.onSpawn,
        onStderr: options?.onStderr,
        onHeartbeat: options?.onHeartbeat,
      });

      // Parse JSONL output
      const parsed = parseCodexJsonl(stdout);

      let output = parsed.text;
      if (Buffer.byteLength(output) > maxBytes) {
        output = Buffer.from(output).subarray(0, maxBytes).toString('utf-8') + TRUNCATION_MARKER;
      }

      const durationMs = Date.now() - start;
      const usage = parsed.usage ?? estimateTokenUsage(prompt, output);

      return {
        text: output,
        model: this.modelId,
        provider: this.provider,
        usage,
        finishReason: 'stop',
        durationMs,
        sessionId: parsed.sessionId,
      };
    };

    // Try resume if sessionId provided
    if (options?.sessionId) {
      try {
        return await doCall(options.sessionId);
      } catch {
        // Resume failed — fall back to fresh exec
        console.error(`[codemoot] Resume failed for session ${options.sessionId}, falling back to fresh exec`);
      }
    }

    return doCall();
  }

  private buildArgs(outputFile: string): string[] {
    return [...this.baseArgs, '-o', outputFile];
  }

  private runProcess(
    command: string,
    args: string[],
    env: Record<string, string>,
    timeout: number,
    stdinData?: string,
    options?: { idleTimeout?: number } & ProgressCallbacks,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let lastActivityAt = startTime;

      const child = spawn(command, args, {
        cwd: this.projectDir ?? tmpdir(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let settled = false;
      const maxCapture = MAX_OUTPUT_BYTES * 2; // Cap memory usage

      // Heartbeat interval — fires every 15s with elapsed time
      const heartbeatInterval = options?.onHeartbeat
        ? setInterval(() => {
            try { options.onHeartbeat?.(Math.round((Date.now() - startTime) / 1000)); } catch { /* callback error isolation */ }
          }, 15_000)
        : undefined;

      const cleanup = () => {
        clearTimeout(absoluteTimer);
        clearTimeout(idleTimer);
        if (heartbeatInterval) clearInterval(heartbeatInterval);
      };

      const fail = (err: ModelError) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      // Notify caller when process successfully spawns
      child.on('spawn', () => {
        try { options?.onSpawn?.(child.pid ?? 0, command); } catch { /* callback error isolation */ }
      });

      // Absolute timeout — hard ceiling, kills no matter what
      const elapsedMsg = () => `elapsed ${Date.now() - startTime}ms, last activity ${Date.now() - lastActivityAt}ms ago`;
      const absoluteTimer = setTimeout(() => {
        killProcessTree(child.pid);
        fail(
          new ModelError(
            `CLI subprocess absolute timeout (limit ${timeout}ms, ${elapsedMsg()})`,
            this.provider,
            this.modelId,
          ),
        );
      }, timeout);

      // Idle timeout — resets on every stdout/stderr chunk. Detects stalled processes.
      const idleMs = options?.idleTimeout ?? 120_000;
      let idleTimer = setTimeout(() => {
        killProcessTree(child.pid);
        fail(
          new ModelError(
            `CLI subprocess idle timeout (no output for ${idleMs}ms, total ${elapsedMsg()})`,
            this.provider,
            this.modelId,
          ),
        );
      }, idleMs);

      const resetIdleTimer = () => {
        lastActivityAt = Date.now();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          killProcessTree(child.pid);
          fail(
            new ModelError(
              `CLI subprocess idle timeout (no output for ${idleMs}ms, total ${elapsedMsg()})`,
              this.provider,
              this.modelId,
            ),
          );
        }, idleMs);
      };

      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdoutBytes += data.byteLength;
        if (stdoutBytes <= maxCapture) {
          stdout += chunk;
        }
        resetIdleTimer();
        try { options?.onProgress?.(chunk); } catch { /* callback error isolation */ }
      });
      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        if (stderr.length < 10_000) stderr += chunk;
        resetIdleTimer();
        try { options?.onStderr?.(chunk); } catch { /* callback error isolation */ }
      });

      if (stdinData) {
        child.stdin.write(stdinData);
        child.stdin.end();
      } else {
        child.stdin.end();
      }

      child.on('error', (err) => {
        fail(
          new ModelError(`CLI subprocess failed: ${err.message}`, this.provider, this.modelId),
        );
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { options?.onClose?.(); } catch { /* callback error isolation */ }
        if (code !== 0) {
          reject(
            new ModelError(
              `CLI subprocess exited with code ${code}: ${stderr.slice(0, 500)}`,
              this.provider,
              this.modelId,
            ),
          );
          return;
        }
        resolve(stdout);
      });
    });
  }
}

export function buildFilteredEnv(allowlist: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of allowlist) {
    const val = process.env[key];
    if (val !== undefined) {
      env[key] = val;
    }
  }
  return env;
}

export function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Process may already be dead
        }
      }, 5000);
    }
  } catch {
    // Process may already be dead
  }
}

/** Estimate tokens using char/4 heuristic. MeteringSource = 'estimated'. */
export function estimateTokenUsage(prompt: string, output: string): TokenUsage {
  const inputTokens = Math.ceil(prompt.length / 4);
  const outputTokens = Math.ceil(output.length / 4);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: 0, // CLI mode = free
  };
}

/** Parse codex --json JSONL output into structured result. */
export function parseCodexJsonl(stdout: string): {
  sessionId?: string;
  text: string;
  usage?: TokenUsage;
} {
  let sessionId: string | undefined;
  const textParts: string[] = [];
  let usage: TokenUsage | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed);

      if (event.type === 'thread.started' && event.thread_id) {
        sessionId = event.thread_id;
      }

      if (
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message' &&
        event.item.text
      ) {
        textParts.push(event.item.text);
      }

      if (event.type === 'turn.completed' && event.usage) {
        const u = event.usage;
        const inputTokens = (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0);
        const outputTokens = u.output_tokens ?? 0;
        usage = {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          costUsd: 0,
        };
      }
    } catch {
      // Skip malformed JSONL lines
    }
  }

  return { sessionId, text: textParts.join('\n'), usage };
}

export { MAX_OUTPUT_BYTES };
