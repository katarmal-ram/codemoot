/**
 * MCP Server E2E Test Harness
 *
 * Spawns the MCP server as a child process, sends JSON-RPC messages,
 * and validates responses for all 5 tools.
 *
 * Usage: npx tsx packages/mcp-server/tests/e2e-harness.ts
 *   --quick   Skip slow tools (plan, debate) — memory + cost + review only
 *   --full    Run all tools including plan and debate (default)
 */

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, '../dist/index.js');
const PROJECT_DIR = resolve(__dirname, '../../..');

const isQuick = process.argv.includes('--quick');

// ── JSON-RPC helpers ──

let rpcId = 0;
function rpcRequest(method: string, params?: unknown): { msg: string; id: number } {
  const id = ++rpcId;
  return { msg: JSON.stringify({ jsonrpc: '2.0', id, method, params }), id };
}
function rpcNotification(method: string, params?: unknown) {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

// ── MCP Client ──

interface McpClient {
  send(msg: string): void;
  waitForId(id: number, timeoutMs?: number): Promise<unknown>;
  close(): void;
  stderr: string;
}

function startMcpServer(): McpClient {
  const child = spawn('node', [SERVER_PATH], {
    cwd: PROJECT_DIR,
    env: { ...process.env, CODEMOOT_PROJECT_DIR: PROJECT_DIR },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buffer = '';
  let stderrBuf = '';
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    // Parse newline-delimited JSON-RPC responses
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id) as {
            resolve: (v: unknown) => void;
            reject: (e: Error) => void;
          };
          pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  return {
    send(msg: string) {
      child.stdin.write(`${msg}\n`);
    },
    waitForId(id: number, timeoutMs = 180_000): Promise<unknown> {
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`Timeout waiting for response id=${id} after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
    get stderr() {
      return stderrBuf;
    },
  };
}

// ── Test definitions ──

interface TestCase {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  validate: (result: unknown) => string | null; // null = pass, string = error message
  slow?: boolean;
}

const tests: TestCase[] = [
  // 1. Memory save
  {
    name: 'codemoot_memory — save',
    tool: 'codemoot_memory',
    args: {
      action: 'save',
      content: 'E2E harness test memory entry',
      category: 'convention',
      importance: 0.3,
    },
    timeoutMs: 5_000,
    validate(result) {
      const r = result as { content: Array<{ text: string }> };
      const data = JSON.parse(r.content[0].text);
      if (!data.saved) return 'Expected saved=true';
      if (typeof data.id !== 'number') return `Expected numeric id, got ${typeof data.id}`;
      return null;
    },
  },
  // 2. Memory search
  {
    name: 'codemoot_memory — search',
    tool: 'codemoot_memory',
    args: { action: 'search', query: 'E2E harness' },
    timeoutMs: 5_000,
    validate(result) {
      const r = result as { content: Array<{ text: string }> };
      const data = JSON.parse(r.content[0].text);
      if (!data.records || data.records.length === 0) return 'Expected at least 1 search result';
      return null;
    },
  },
  // 3. Cost query
  {
    name: 'codemoot_cost — all scope',
    tool: 'codemoot_cost',
    args: { scope: 'all' },
    timeoutMs: 5_000,
    validate(result) {
      const r = result as { content: Array<{ text: string }> };
      // Cost may return empty array if no prior sessions — that's fine
      const data = JSON.parse(r.content[0].text);
      if (!Array.isArray(data)) return `Expected array, got ${typeof data}`;
      return null;
    },
  },
  // 4. Review (uses codex CLI)
  {
    name: 'codemoot_review — fibonacci',
    tool: 'codemoot_review',
    args: {
      content: 'function fib(n) { if (n <= 1) return n; return fib(n-1) + fib(n-2); }',
      criteria: ['performance', 'correctness'],
    },
    timeoutMs: 60_000,
    validate(result) {
      const r = result as { content: Array<{ text: string }>; isError?: boolean };
      if (r.isError) return `Tool returned error: ${r.content[0].text}`;
      const data = JSON.parse(r.content[0].text);
      if (data.status !== 'success') return `Expected status=success, got ${data.status}`;
      if (typeof data.score !== 'number') return `Expected numeric score, got ${typeof data.score}`;
      if (!data.verdict) return 'Missing verdict';
      if (!data.feedback || !Array.isArray(data.feedback)) return 'Missing or non-array feedback';
      return null;
    },
  },
  // 5. Plan (uses codex CLI, slow)
  {
    name: 'codemoot_plan — login validation',
    tool: 'codemoot_plan',
    args: { task: 'Add email validation to a login form', maxRounds: 1 },
    timeoutMs: 180_000,
    slow: true,
    validate(result) {
      const r = result as { content: Array<{ text: string }>; isError?: boolean };
      if (r.isError) return `Tool returned error: ${r.content[0].text}`;
      const data = JSON.parse(r.content[0].text);
      if (!data.sessionId) return 'Missing sessionId';
      if (data.status !== 'completed' && data.status !== 'failed')
        return `Unexpected status: ${data.status}`;
      if (data.status === 'failed') return `Plan failed: ${data.error}`;
      if (!data.finalOutput || data.finalOutput.length < 50) return 'Final output too short';
      return null;
    },
  },
  // 6. Debate (uses codex CLI, slow)
  {
    name: 'codemoot_debate — single model',
    tool: 'codemoot_debate',
    args: {
      question: 'Is TypeScript worth it for small projects? One sentence.',
      models: ['codex-architect'],
      synthesize: false,
    },
    timeoutMs: 60_000,
    slow: true,
    validate(result) {
      const r = result as { content: Array<{ text: string }>; isError?: boolean };
      if (r.isError) return `Tool returned error: ${r.content[0].text}`;
      const data = JSON.parse(r.content[0].text);
      if (data.status !== 'success') return `Expected status=success, got ${data.status}`;
      if (!data.responses || data.responses.length === 0) return 'No debate responses';
      if (!data.responses[0].text) return 'First response has no text';
      return null;
    },
  },
];

// ── Runner ──

async function main() {
  const activeCases = isQuick ? tests.filter((t) => !t.slow) : tests;

  console.log(`\n  CodeMoot MCP E2E Harness (${isQuick ? 'quick' : 'full'} mode)\n`);
  console.log(`  Server: ${SERVER_PATH}`);
  console.log(`  Project: ${PROJECT_DIR}`);
  console.log(`  Tests: ${activeCases.length}\n`);

  const client = startMcpServer();

  // Wait for server startup
  await sleep(500);

  // Handshake
  const init = rpcRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-harness', version: '1.0' },
  });
  client.send(init.msg);
  const initResult = await client.waitForId(init.id, 10_000);
  const serverInfo = (initResult as { serverInfo?: { name: string; version: string } }).serverInfo;
  console.log(`  Connected: ${serverInfo?.name} v${serverInfo?.version}\n`);

  client.send(rpcNotification('notifications/initialized'));
  await sleep(200);

  // Run tests sequentially
  let passed = 0;
  let failed = 0;
  const failures: Array<{ name: string; error: string }> = [];

  for (const test of activeCases) {
    const callId = ++rpcId;
    const start = Date.now();
    process.stdout.write(`  ${test.slow ? '🐢' : '⚡'} ${test.name} ... `);

    client.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: callId,
        method: 'tools/call',
        params: { name: test.tool, arguments: test.args },
      }),
    );

    try {
      const result = await client.waitForId(callId, test.timeoutMs);
      const elapsed = Date.now() - start;
      const error = test.validate(result);

      if (error) {
        console.log(`FAIL (${fmtMs(elapsed)}) — ${error}`);
        failed++;
        failures.push({ name: test.name, error });
      } else {
        console.log(`PASS (${fmtMs(elapsed)})`);
        passed++;
      }
    } catch (err) {
      const elapsed = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`FAIL (${fmtMs(elapsed)}) — ${msg}`);
      failed++;
      failures.push({ name: test.name, error: msg });
    }
  }

  // Cleanup: delete the test memory we saved
  const delId = ++rpcId;
  client.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: delId,
      method: 'tools/call',
      params: {
        name: 'codemoot_memory',
        arguments: { action: 'search', query: 'E2E harness test memory entry' },
      },
    }),
  );
  try {
    const searchResult = (await client.waitForId(delId, 5_000)) as {
      content: Array<{ text: string }>;
    };
    const data = JSON.parse(searchResult.content[0].text);
    for (const record of data.records ?? []) {
      const did = ++rpcId;
      client.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: did,
          method: 'tools/call',
          params: { name: 'codemoot_memory', arguments: { action: 'delete', memoryId: record.id } },
        }),
      );
      await client.waitForId(did, 3_000).catch(() => {});
    }
  } catch {
    // cleanup is best-effort
  }

  client.close();

  // Report
  console.log('\n  ─────────────────────────────────');
  console.log(`  Results: ${passed} passed, ${failed} failed, ${activeCases.length} total`);

  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) {
      console.log(`    ✗ ${f.name}: ${f.error}`);
    }
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(2);
});
