import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process before importing modules under test
vi.mock('node:child_process', () => {
  const mockOn = vi.fn();
  const mockStdout = { on: vi.fn() };
  const mockStderr = { on: vi.fn() };
  const mockStdin = { write: vi.fn(), end: vi.fn() };
  const mockSpawn = vi.fn(() => ({
    stdout: mockStdout,
    stderr: mockStderr,
    stdin: mockStdin,
    on: mockOn,
    pid: 12345,
  }));
  const mockExecFile = vi.fn();
  return {
    spawn: mockSpawn,
    execFile: mockExecFile,
  };
});

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn(),
}));

// Mock node:os for tmpdir
vi.mock('node:os', () => ({
  tmpdir: vi.fn(() => '/tmp'),
}));

import { execFile, spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import {
  CliAdapter,
  MAX_OUTPUT_BYTES,
  buildFilteredEnv,
  estimateTokenUsage,
  killProcessTree,
} from '../../../src/models/cli-adapter.js';
import {
  clearDetectionCache,
  detectCli,
  getCacheForTesting,
} from '../../../src/models/cli-detector.js';

// ------------------------------------------------------------------
// CliAdapter tests
// ------------------------------------------------------------------
describe('CliAdapter', () => {
  let adapter: CliAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    adapter = new CliAdapter({
      command: 'codex',
      args: ['exec', '--skip-git-repo-check'],
      provider: 'openai',
      model: 'gpt-5.3-codex',
      cliName: 'codex',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupSpawnSuccess(stdoutData: string, exitCode = 0, stderrData?: string) {
    const mockSpawn = vi.mocked(spawn);
    const stdoutOn = vi.fn();
    const stderrOn = vi.fn();
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn();
    const onFn = vi.fn();

    mockSpawn.mockReturnValue({
      stdout: { on: stdoutOn },
      stderr: { on: stderrOn },
      stdin: { write: stdinWrite, end: stdinEnd },
      on: onFn,
      pid: 12345,
    } as never);

    // Store data callbacks and call them after spawn returns
    stdoutOn.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') {
        setTimeout(() => cb(Buffer.from(stdoutData)), 1);
      }
    });
    stderrOn.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data' && stderrData) {
        setTimeout(() => cb(Buffer.from(stderrData)), 1);
      }
    });

    onFn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'spawn') {
        setTimeout(() => cb(), 0);
      }
      if (event === 'close') {
        setTimeout(() => cb(exitCode), 2);
      }
    });
  }

  function setupSpawnError(errorMessage: string) {
    const mockSpawn = vi.mocked(spawn);
    const stdoutOn = vi.fn();
    const stderrOn = vi.fn();
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn();
    const onFn = vi.fn();

    mockSpawn.mockReturnValue({
      stdout: { on: stdoutOn },
      stderr: { on: stderrOn },
      stdin: { write: stdinWrite, end: stdinEnd },
      on: onFn,
      pid: 12345,
    } as never);

    stdoutOn.mockImplementation(() => {});
    stderrOn.mockImplementation(() => {});

    onFn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'error') {
        setTimeout(() => cb(new Error(errorMessage)), 1);
      }
    });
  }

  function setupSpawnNonZeroExit(exitCode: number, stderrData: string) {
    const mockSpawn = vi.mocked(spawn);
    const stdoutOn = vi.fn();
    const stderrOn = vi.fn();
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn();
    const onFn = vi.fn();

    mockSpawn.mockReturnValue({
      stdout: { on: stdoutOn },
      stderr: { on: stderrOn },
      stdin: { write: stdinWrite, end: stdinEnd },
      on: onFn,
      pid: 12345,
    } as never);

    stdoutOn.mockImplementation(() => {});
    stderrOn.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') {
        setTimeout(() => cb(Buffer.from(stderrData)), 1);
      }
    });

    onFn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') {
        setTimeout(() => cb(exitCode), 2);
      }
    });
  }

  it('returns ModelCallResult with estimated usage on success', async () => {
    setupSpawnSuccess('done');
    vi.mocked(readFile).mockResolvedValue('Review looks good, VERDICT: APPROVED');
    vi.mocked(unlink).mockResolvedValue();

    const result = await adapter.call('Review this code');

    expect(result.text).toBe('Review looks good, VERDICT: APPROVED');
    expect(result.model).toBe('gpt-5.3-codex');
    expect(result.provider).toBe('openai');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.costUsd).toBe(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes correct args for codex CLI', async () => {
    setupSpawnSuccess('done');
    vi.mocked(readFile).mockResolvedValue('output');
    vi.mocked(unlink).mockResolvedValue();

    const mockSpawn = vi.mocked(spawn);
    await adapter.call('test prompt');

    const callArgs = mockSpawn.mock.calls[0];
    expect(callArgs[0]).toBe('codex');
    // Args: base args + -o + tmpFile (prompt sent via stdin, not as arg)
    const spawnArgs = callArgs[1] as string[];
    expect(spawnArgs[0]).toBe('exec');
    expect(spawnArgs[1]).toBe('--skip-git-repo-check');
    expect(spawnArgs[2]).toBe('-o');
    expect(spawnArgs[3]).toContain('codemoot-cli-');
    expect(spawnArgs.length).toBe(4); // no prompt arg
  });

  it('truncates output exceeding maxOutputBytes', async () => {
    const bigOutput = 'x'.repeat(MAX_OUTPUT_BYTES + 1000);
    setupSpawnSuccess('done');
    vi.mocked(readFile).mockResolvedValue(bigOutput);
    vi.mocked(unlink).mockResolvedValue();

    const result = await adapter.call('prompt');

    expect(result.text.length).toBeLessThanOrEqual(
      MAX_OUTPUT_BYTES + '\n[TRUNCATED: output exceeded 512KB]'.length,
    );
    expect(result.text).toContain('[TRUNCATED: output exceeded 512KB]');
  });

  it('respects custom maxOutputBytes option', async () => {
    const output = 'x'.repeat(200);
    setupSpawnSuccess('done');
    vi.mocked(readFile).mockResolvedValue(output);
    vi.mocked(unlink).mockResolvedValue();

    const result = await adapter.call('prompt', { maxOutputBytes: 100 });

    expect(result.text).toContain('[TRUNCATED: output exceeded 512KB]');
    // 100 chars of content + truncation marker
    expect(result.text.startsWith('x'.repeat(100))).toBe(true);
  });

  it('throws ModelError on non-zero exit code', async () => {
    setupSpawnNonZeroExit(1, 'authentication failed');
    vi.mocked(unlink).mockResolvedValue();

    await expect(adapter.call('prompt')).rejects.toThrow('CLI subprocess exited with code 1');
  });

  it('includes stderr in error message on non-zero exit', async () => {
    setupSpawnNonZeroExit(2, 'some error details');
    vi.mocked(unlink).mockResolvedValue();

    await expect(adapter.call('prompt')).rejects.toThrow('some error details');
  });

  it('throws ModelError when spawn emits error event', async () => {
    setupSpawnError('ENOENT');
    vi.mocked(unlink).mockResolvedValue();

    await expect(adapter.call('prompt')).rejects.toThrow('CLI subprocess failed: ENOENT');
  });

  it('throws ModelError with correct provider and model', async () => {
    setupSpawnError('spawn failed');
    vi.mocked(unlink).mockResolvedValue();

    try {
      await adapter.call('prompt');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect((err as { provider: string }).provider).toBe('openai');
      expect((err as { model: string }).model).toBe('gpt-5.3-codex');
    }
  });

  it('cleans up temp file on success', async () => {
    setupSpawnSuccess('done');
    vi.mocked(readFile).mockResolvedValue('output');
    vi.mocked(unlink).mockResolvedValue();

    await adapter.call('prompt');

    expect(unlink).toHaveBeenCalledTimes(1);
    const unlinkPath = vi.mocked(unlink).mock.calls[0][0] as string;
    expect(unlinkPath).toContain('codemoot-cli-');
  });

  it('cleans up temp file on failure', async () => {
    setupSpawnError('boom');
    vi.mocked(unlink).mockResolvedValue();

    try {
      await adapter.call('prompt');
    } catch {
      // Expected
    }

    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it('does not throw if temp file cleanup fails', async () => {
    setupSpawnSuccess('done');
    vi.mocked(readFile).mockResolvedValue('output');
    vi.mocked(unlink).mockRejectedValue(new Error('ENOENT'));

    // Should not throw despite unlink failure
    const result = await adapter.call('prompt');
    expect(result.text).toBe('output');
  });

  it('spawns process in tmpdir with windowsHide', async () => {
    setupSpawnSuccess('done');
    vi.mocked(readFile).mockResolvedValue('output');
    vi.mocked(unlink).mockResolvedValue();

    const mockSpawn = vi.mocked(spawn);
    await adapter.call('prompt');

    const spawnOpts = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
    expect(spawnOpts.cwd).toBe('/tmp');
    expect(spawnOpts.windowsHide).toBe(true);
    expect(spawnOpts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  // ── Progress callback tests ──

  it('calls onSpawn with PID after process spawns', async () => {
    setupSpawnSuccess('done');
    vi.mocked(readFile).mockResolvedValue('output');
    vi.mocked(unlink).mockResolvedValue();

    const onSpawn = vi.fn();
    await adapter.call('prompt', { onSpawn });

    expect(onSpawn).toHaveBeenCalledWith(12345, 'codex');
  });

  it('calls onStderr with stderr data chunks', async () => {
    setupSpawnSuccess('done', 0, 'tool call started\ntool call done');
    vi.mocked(readFile).mockResolvedValue('output');
    vi.mocked(unlink).mockResolvedValue();

    const onStderr = vi.fn();
    await adapter.call('prompt', { onStderr });

    expect(onStderr).toHaveBeenCalledWith('tool call started\ntool call done');
  });

  it('calls onProgress with stdout data chunks', async () => {
    setupSpawnSuccess('hello world');
    vi.mocked(readFile).mockResolvedValue('output');
    vi.mocked(unlink).mockResolvedValue();

    const onProgress = vi.fn();
    await adapter.call('prompt', { onProgress });

    expect(onProgress).toHaveBeenCalledWith('hello world');
  });

  it('does not crash if onSpawn callback throws', async () => {
    setupSpawnSuccess('done');
    vi.mocked(readFile).mockResolvedValue('output');
    vi.mocked(unlink).mockResolvedValue();

    const onSpawn = vi.fn(() => { throw new Error('callback boom'); });
    const result = await adapter.call('prompt', { onSpawn });

    expect(result.text).toBe('output');
  });

  it('does not crash if onStderr callback throws', async () => {
    setupSpawnSuccess('done', 0, 'stderr data');
    vi.mocked(readFile).mockResolvedValue('output');
    vi.mocked(unlink).mockResolvedValue();

    const onStderr = vi.fn(() => { throw new Error('callback boom'); });
    const result = await adapter.call('prompt', { onStderr });

    expect(result.text).toBe('output');
  });

  it('calls onHeartbeat periodically with elapsed seconds', async () => {
    const mockSpawn = vi.mocked(spawn);
    const stdoutOn = vi.fn();
    const stderrOn = vi.fn();
    const onFn = vi.fn();

    mockSpawn.mockReturnValue({
      stdout: { on: stdoutOn },
      stderr: { on: stderrOn },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: onFn,
      pid: 12345,
    } as never);

    // Emit stdout data periodically to prevent idle timeout, then close after 20s
    stdoutOn.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') {
        // Emit data at 5s, 10s, 18s to keep idle timer alive
        setTimeout(() => cb(Buffer.from('a')), 5000);
        setTimeout(() => cb(Buffer.from('b')), 10000);
        setTimeout(() => cb(Buffer.from('c')), 18000);
      }
    });
    stderrOn.mockImplementation(() => {});
    onFn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'spawn') setTimeout(() => cb(), 0);
      if (event === 'close') setTimeout(() => cb(0), 20000);
    });

    vi.mocked(readFile).mockResolvedValue('output');
    vi.mocked(unlink).mockResolvedValue();

    const onHeartbeat = vi.fn();
    const promise = adapter.call('prompt', { onHeartbeat, idleTimeout: 15000 });
    await vi.advanceTimersByTimeAsync(21000);
    await promise;

    // Heartbeat fires at 15s (every 15s interval)
    expect(onHeartbeat).toHaveBeenCalledWith(15);
  });

  it('clears heartbeat interval on process exit (no leak)', async () => {
    setupSpawnSuccess('done');
    vi.mocked(readFile).mockResolvedValue('output');
    vi.mocked(unlink).mockResolvedValue();

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const onHeartbeat = vi.fn();
    await adapter.call('prompt', { onHeartbeat });

    // clearInterval should have been called during cleanup
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('timeout error message includes elapsed time', async () => {
    const mockSpawn = vi.mocked(spawn);
    const onFn = vi.fn();
    mockSpawn.mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: onFn,
      pid: 12345,
    } as never);

    // Never close or emit data — will timeout
    onFn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'spawn') setTimeout(() => cb(), 0);
    });

    vi.mocked(unlink).mockResolvedValue();

    // Catch the promise immediately so the rejection is handled
    const promise = adapter.call('prompt', { timeout: 100, idleTimeout: 50 }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(200);

    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/idle timeout/i);
    expect((err as Error).message).toMatch(/elapsed/i);
  });

  it('filters environment variables to allowlist only', async () => {
    // Set some env vars
    const originalPath = process.env.PATH;
    const originalSecret = process.env.SECRET_KEY;
    process.env.PATH = '/usr/bin';
    process.env.SECRET_KEY = 'should-not-pass';
    process.env.OPENAI_API_KEY = 'sk-test';

    setupSpawnSuccess('done');
    vi.mocked(readFile).mockResolvedValue('output');
    vi.mocked(unlink).mockResolvedValue();

    const mockSpawn = vi.mocked(spawn);
    await adapter.call('prompt');

    const spawnOpts = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
    const env = spawnOpts.env as Record<string, string>;
    expect(env.PATH).toBe('/usr/bin');
    expect(env.OPENAI_API_KEY).toBe('sk-test');
    expect(env.SECRET_KEY).toBeUndefined();

    // Restore
    process.env.PATH = originalPath;
    if (originalSecret === undefined) {
      process.env.SECRET_KEY = '';
    } else {
      process.env.SECRET_KEY = originalSecret;
    }
  });
});

// ------------------------------------------------------------------
// buildFilteredEnv tests
// ------------------------------------------------------------------
describe('buildFilteredEnv', () => {
  it('only includes vars from the allowlist', () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/usr/bin';
    process.env.SUPER_SECRET = 'nope';

    const env = buildFilteredEnv(['PATH']);

    expect(env.PATH).toBe('/usr/bin');
    expect(env.SUPER_SECRET).toBeUndefined();

    // Restore
    process.env.PATH = originalPath;
    process.env.SUPER_SECRET = '';
  });

  it('skips vars not present in process.env', () => {
    const env = buildFilteredEnv(['NONEXISTENT_VAR_XYZ']);
    expect(env.NONEXISTENT_VAR_XYZ).toBeUndefined();
    expect(Object.keys(env).length).toBe(0);
  });

  it('returns empty object for empty allowlist', () => {
    const env = buildFilteredEnv([]);
    expect(Object.keys(env).length).toBe(0);
  });

  it('includes multiple allowed vars', () => {
    process.env.TEST_VAR_A = 'a';
    process.env.TEST_VAR_B = 'b';

    const env = buildFilteredEnv(['TEST_VAR_A', 'TEST_VAR_B']);

    expect(env.TEST_VAR_A).toBe('a');
    expect(env.TEST_VAR_B).toBe('b');

    // Cleanup
    process.env.TEST_VAR_A = '';
    process.env.TEST_VAR_B = '';
  });
});

// ------------------------------------------------------------------
// estimateTokenUsage tests
// ------------------------------------------------------------------
describe('estimateTokenUsage', () => {
  it('uses char/4 formula for input tokens', () => {
    const usage = estimateTokenUsage('hello world', '');
    // 'hello world' = 11 chars, ceil(11/4) = 3
    expect(usage.inputTokens).toBe(3);
  });

  it('uses char/4 formula for output tokens', () => {
    const usage = estimateTokenUsage('', 'response text here');
    // 18 chars, ceil(18/4) = 5
    expect(usage.outputTokens).toBe(5);
  });

  it('calculates totalTokens as input + output', () => {
    const usage = estimateTokenUsage('abcd', 'efgh');
    // 4/4=1, 4/4=1
    expect(usage.inputTokens).toBe(1);
    expect(usage.outputTokens).toBe(1);
    expect(usage.totalTokens).toBe(2);
  });

  it('always returns costUsd of 0 for CLI mode', () => {
    const usage = estimateTokenUsage('long prompt '.repeat(100), 'big output '.repeat(100));
    expect(usage.costUsd).toBe(0);
  });

  it('handles empty strings', () => {
    const usage = estimateTokenUsage('', '');
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.totalTokens).toBe(0);
  });

  it('rounds up with Math.ceil', () => {
    // 1 char -> ceil(1/4) = 1
    const usage = estimateTokenUsage('a', 'b');
    expect(usage.inputTokens).toBe(1);
    expect(usage.outputTokens).toBe(1);
  });
});

// ------------------------------------------------------------------
// killProcessTree tests
// ------------------------------------------------------------------
describe('killProcessTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when pid is undefined', () => {
    const mockSpawn = vi.mocked(spawn);
    killProcessTree(undefined);
    // spawn should not be called for taskkill
    // Only checking it does not throw
  });

  it('uses taskkill on win32', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    const mockSpawn = vi.mocked(spawn);
    mockSpawn.mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      pid: 99,
    } as never);

    killProcessTree(12345);

    expect(mockSpawn).toHaveBeenCalledWith('taskkill', ['/pid', '12345', '/T', '/F'], {
      stdio: 'ignore',
    });

    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('uses SIGTERM on non-win32', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    killProcessTree(12345);

    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

    killSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('does not throw if process is already dead', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    // Should not throw
    expect(() => killProcessTree(99999)).not.toThrow();

    killSpy.mockRestore();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });
});

// ------------------------------------------------------------------
// callWithResume tests
// ------------------------------------------------------------------
describe('callWithResume', () => {
  let adapter: CliAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    adapter = new CliAdapter({
      command: 'codex',
      args: ['exec', '--skip-git-repo-check'],
      provider: 'openai',
      model: 'gpt-5.3-codex',
      cliName: 'codex',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupJsonlSpawn(jsonlLines: string[], exitCode = 0) {
    const mockSpawn = vi.mocked(spawn);
    const stdoutOn = vi.fn();
    const stderrOn = vi.fn();
    const stdinWrite = vi.fn();
    const stdinEnd = vi.fn();
    const onFn = vi.fn();

    mockSpawn.mockReturnValue({
      stdout: { on: stdoutOn },
      stderr: { on: stderrOn },
      stdin: { write: stdinWrite, end: stdinEnd },
      on: onFn,
      pid: 12345,
    } as never);

    const fullOutput = jsonlLines.join('\n');
    stdoutOn.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') {
        setTimeout(() => cb(Buffer.from(fullOutput)), 1);
      }
    });
    stderrOn.mockImplementation(() => {});

    onFn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'spawn') setTimeout(() => cb(), 0);
      if (event === 'close') setTimeout(() => cb(exitCode), 2);
    });

    return { stdinWrite, stdinEnd };
  }

  it('parses sessionId from thread.started JSONL', async () => {
    setupJsonlSpawn([
      '{"type":"thread.started","thread_id":"thread_abc123"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Hello"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
    ]);

    const result = await adapter.callWithResume('test prompt');

    expect(result.sessionId).toBe('thread_abc123');
    expect(result.text).toBe('Hello');
  });

  it('concatenates text from multiple agent_message items', async () => {
    setupJsonlSpawn([
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Part 1. "}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Part 2."}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":8}}',
    ]);

    const result = await adapter.callWithResume('prompt');

    expect(result.text).toBe('Part 1. \nPart 2.');
  });

  it('handles malformed JSONL lines gracefully', async () => {
    setupJsonlSpawn([
      '{"type":"thread.started","thread_id":"t1"}',
      'NOT VALID JSON',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Works"}}',
    ]);

    const result = await adapter.callWithResume('prompt');

    expect(result.text).toBe('Works');
    expect(result.sessionId).toBe('t1');
  });

  it('passes onSpawn callback to runProcess', async () => {
    setupJsonlSpawn([
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Ok"}}',
    ]);

    const onSpawn = vi.fn();
    await adapter.callWithResume('prompt', { onSpawn });

    expect(onSpawn).toHaveBeenCalledWith(12345, expect.stringContaining('codex'));
  });

  it('passes onStderr callback to runProcess', async () => {
    const mockSpawn = vi.mocked(spawn);
    const stdoutOn = vi.fn();
    const stderrOn = vi.fn();
    const onFn = vi.fn();

    mockSpawn.mockReturnValue({
      stdout: { on: stdoutOn },
      stderr: { on: stderrOn },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: onFn,
      pid: 12345,
    } as never);

    const jsonl = '{"type":"item.completed","item":{"type":"agent_message","text":"Ok"}}';
    stdoutOn.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') setTimeout(() => cb(Buffer.from(jsonl)), 1);
    });
    stderrOn.mockImplementation((event: string, cb: (data: Buffer) => void) => {
      if (event === 'data') setTimeout(() => cb(Buffer.from('tool running')), 1);
    });
    onFn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'spawn') setTimeout(() => cb(), 0);
      if (event === 'close') setTimeout(() => cb(0), 2);
    });

    const onStderr = vi.fn();
    await adapter.callWithResume('prompt', { onStderr });

    expect(onStderr).toHaveBeenCalledWith('tool running');
  });

  it('falls back to fresh exec on resume failure', async () => {
    const mockSpawn = vi.mocked(spawn);
    let callCount = 0;

    mockSpawn.mockImplementation(() => {
      callCount++;
      const stdoutOn = vi.fn();
      const stderrOn = vi.fn();
      const onFn = vi.fn();

      if (callCount === 1) {
        // First call (resume) — fail with non-zero exit
        stdoutOn.mockImplementation(() => {});
        stderrOn.mockImplementation((event: string, cb: (data: Buffer) => void) => {
          if (event === 'data') setTimeout(() => cb(Buffer.from('resume failed')), 1);
        });
        onFn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
          if (event === 'spawn') setTimeout(() => cb(), 0);
          if (event === 'close') setTimeout(() => cb(1), 2);
        });
      } else {
        // Second call (fresh) — succeed
        const jsonl = '{"type":"thread.started","thread_id":"new_thread"}\n{"type":"item.completed","item":{"type":"agent_message","text":"Fresh response"}}';
        stdoutOn.mockImplementation((event: string, cb: (data: Buffer) => void) => {
          if (event === 'data') setTimeout(() => cb(Buffer.from(jsonl)), 1);
        });
        stderrOn.mockImplementation(() => {});
        onFn.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
          if (event === 'spawn') setTimeout(() => cb(), 0);
          if (event === 'close') setTimeout(() => cb(0), 2);
        });
      }

      return {
        stdout: { on: stdoutOn },
        stderr: { on: stderrOn },
        stdin: { write: vi.fn(), end: vi.fn() },
        on: onFn,
        pid: 12345,
      } as never;
    });

    const result = await adapter.callWithResume('prompt', { sessionId: 'old_thread' });

    expect(result.sessionId).toBe('new_thread');
    expect(result.text).toBe('Fresh response');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });
});

// ------------------------------------------------------------------
// detectCli tests
// ------------------------------------------------------------------
describe('detectCli', () => {
  const mockedExecFile = vi.mocked(execFile);

  beforeEach(() => {
    vi.clearAllMocks();
    clearDetectionCache();
  });

  function mockExecFileSequence(calls: Array<{ stdout?: string; stderr?: string; error?: Error }>) {
    let callIndex = 0;
    mockedExecFile.mockImplementation(((
      _cmd: string,
      _args: unknown,
      _opts: unknown,
      cb?: unknown,
    ) => {
      const call = calls[callIndex] ?? calls[calls.length - 1];
      callIndex++;
      // execFile with promisify: the mock needs to call the callback
      if (typeof cb === 'function') {
        if (call.error) {
          (cb as (err: Error) => void)(call.error);
        } else {
          (cb as (err: null, result: { stdout: string; stderr: string }) => void)(null, {
            stdout: call.stdout ?? '',
            stderr: call.stderr ?? '',
          });
        }
      }
    }) as never);
  }

  it('returns available=true when CLI is found and auth succeeds', async () => {
    mockExecFileSequence([
      { stdout: '/usr/local/bin/codex\n' }, // which
      { stdout: 'codex v0.98.0\n' }, // --version
      { stdout: 'ok\n' }, // exec smoke test
    ]);

    const result = await detectCli('codex');

    expect(result.available).toBe(true);
    expect(result.path).toBe('/usr/local/bin/codex');
    expect(result.version).toBe('codex v0.98.0');
    expect(result.authOk).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns available=false when CLI is not in PATH', async () => {
    mockExecFileSequence([
      { error: new Error('not found') }, // which fails
    ]);

    const result = await detectCli('codex');

    expect(result.available).toBe(false);
    expect(result.error).toBe('codex not found in PATH');
  });

  it('returns authOk=false when smoke test fails', async () => {
    mockExecFileSequence([
      { stdout: '/usr/local/bin/codex\n' }, // which
      { stdout: 'codex v0.98.0\n' }, // --version
      { error: new Error('auth required') }, // exec fails
    ]);

    const result = await detectCli('codex');

    expect(result.available).toBe(true);
    expect(result.authOk).toBe(false);
    expect(result.error).toContain('Auth check failed');
  });

  it('returns result without version if version check fails', async () => {
    mockExecFileSequence([
      { stdout: '/usr/local/bin/codex\n' }, // which
      { error: new Error('no version flag') }, // --version fails
      { stdout: 'ok\n' }, // exec smoke test
    ]);

    const result = await detectCli('codex');

    expect(result.available).toBe(true);
    expect(result.version).toBeUndefined();
    expect(result.authOk).toBe(true);
  });

  it('returns cached result within TTL', async () => {
    mockExecFileSequence([
      { stdout: '/usr/local/bin/codex\n' },
      { stdout: 'v1.0\n' },
      { stdout: 'ok\n' },
    ]);

    const first = await detectCli('codex');
    const second = await detectCli('codex');

    // Should only have called execFile for the first detection
    expect(first).toBe(second);
    // execFile called 3 times for first call, 0 for second (cached)
    expect(mockedExecFile).toHaveBeenCalledTimes(3);
  });

  it('re-probes after TTL expiry', async () => {
    vi.useRealTimers();
    const cache = getCacheForTesting();

    // Insert an expired cache entry
    cache.set('codex', {
      available: true,
      path: '/old/path',
      authOk: true,
      detectedAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago, past TTL
    });

    mockExecFileSequence([
      { stdout: '/new/path/codex\n' },
      { stdout: 'v2.0\n' },
      { stdout: 'ok\n' },
    ]);

    const result = await detectCli('codex');

    expect(result.path).toBe('/new/path/codex');
    expect(mockedExecFile).toHaveBeenCalled();
  });

  it('clearDetectionCache clears all cached entries', async () => {
    const cache = getCacheForTesting();
    cache.set('codex', {
      available: true,
      detectedAt: Date.now(),
    });

    clearDetectionCache();

    expect(cache.size).toBe(0);
  });

  it('takes first path on Windows where output', async () => {
    mockExecFileSequence([
      { stdout: 'C:\\Program Files\\codex\\codex.exe\nC:\\codex\\codex.exe\n' },
      { stdout: 'v1.0\n' },
      { stdout: 'ok\n' },
    ]);

    const result = await detectCli('codex');

    expect(result.path).toBe('C:\\Program Files\\codex\\codex.exe');
  });
});
