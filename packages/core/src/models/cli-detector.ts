// packages/core/src/models/cli-detector.ts — Detect codex CLI availability

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CliDetectionResult {
  available: boolean;
  path?: string;
  version?: string;
  authOk?: boolean;
  detectedAt: number;
  error?: string;
}

// Cache TTL: 5 minutes
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map<string, CliDetectionResult>();

export async function detectCli(name: 'codex'): Promise<CliDetectionResult> {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.detectedAt < CACHE_TTL) {
    return cached;
  }

  const result = await probeCliTool(name);
  cache.set(name, result);
  return result;
}

export function clearDetectionCache(): void {
  cache.clear();
}

/** Exported for testing - get direct access to the cache */
export function getCacheForTesting(): Map<string, CliDetectionResult> {
  return cache;
}

async function probeCliTool(name: 'codex'): Promise<CliDetectionResult> {
  const now = Date.now();

  // Step 1: Find executable
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  let exePath: string;
  try {
    const { stdout } = await execFileAsync(whichCmd, [name], { timeout: 5000 });
    exePath = stdout.trim().split('\n')[0];
  } catch {
    return {
      available: false,
      detectedAt: now,
      error: `${name} not found in PATH`,
    };
  }

  // Step 2: Get version
  let version: string | undefined;
  try {
    const { stdout } = await execFileAsync(name, ['--version'], {
      timeout: 5000,
    });
    version = stdout.trim();
  } catch {
    // Version check failed, continue without it
  }

  // Step 3: Smoke test (auth check)
  let authOk = false;
  try {
    await execFileAsync(name, ['exec', '--skip-git-repo-check', 'echo ok'], { timeout: 15000 });
    authOk = true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      available: true,
      path: exePath,
      version,
      authOk: false,
      detectedAt: now,
      error: `Auth check failed: ${errMsg}`,
    };
  }

  return {
    available: true,
    path: exePath,
    version,
    authOk,
    detectedAt: now,
  };
}
