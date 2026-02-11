// packages/mcp-server/src/server.ts — MCP server setup with 5 tool handlers

import { join } from 'node:path';
import {
  CancellationToken,
  CostStore,
  MemoryStore,
  ModelRegistry,
  Orchestrator,
  MCP_CONTENT_MAX_LENGTH,
  MCP_TASK_MAX_LENGTH,
  loadConfig,
  openDatabase,
} from '@codemoot/core';
import type { ProjectConfig } from '@codemoot/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { handleCost, handleDebate, handleMemory, handlePlan, handleReview } from './tools/index.js';

const TOOL_DEFINITIONS = [
  {
    name: 'codemoot_review',
    description:
      'Review code or content with a configured AI model. Returns score, verdict, and feedback.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: 'Content to review',
          minLength: 1,
          maxLength: MCP_CONTENT_MAX_LENGTH,
        },
        criteria: { type: 'array', items: { type: 'string' }, description: 'Review criteria' },
        model: { type: 'string', description: 'Model alias override' },
        strict: { type: 'boolean', description: 'Enable strict DLP mode', default: true },
        timeout: { type: 'number', description: 'Timeout in seconds', default: 600 },
      },
      required: ['content'],
    },
  },
  {
    name: 'codemoot_plan',
    description:
      'Generate and iterate on a plan using multi-model review loops. Returns the refined plan.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        task: { type: 'string', description: 'Task to plan', minLength: 1, maxLength: MCP_TASK_MAX_LENGTH },
        maxRounds: { type: 'integer', description: 'Max review rounds', default: 3 },
        stream: { type: 'boolean', description: 'Enable streaming', default: false },
        timeout: { type: 'number', description: 'Timeout in seconds', default: 600 },
      },
      required: ['task'],
    },
  },
  {
    name: 'codemoot_debate',
    description:
      'Debate a question across multiple AI models concurrently. Returns per-model responses and optional synthesis.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        question: {
          type: 'string',
          description: 'Question to debate',
          minLength: 1,
          maxLength: MCP_TASK_MAX_LENGTH,
        },
        models: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 5,
          description: 'Model aliases',
        },
        synthesize: { type: 'boolean', description: 'Synthesize responses', default: false },
        maxRounds: {
          type: 'integer',
          description: 'Max review rounds',
          default: 3,
          minimum: 1,
          maximum: 10,
        },
        timeout: { type: 'number', description: 'Timeout in seconds', default: 600 },
      },
      required: ['question'],
    },
  },
  {
    name: 'codemoot_memory',
    description:
      'Save, search, retrieve, or delete project memories (decisions, conventions, patterns).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['save', 'search', 'get', 'delete'],
          description: 'Memory operation',
        },
        content: { type: 'string', description: 'Content to save' },
        query: { type: 'string', description: 'Search query' },
        memoryId: { type: 'integer', description: 'Memory record ID' },
        category: {
          type: 'string',
          enum: ['decision', 'convention', 'pattern', 'issue', 'preference'],
          description: 'Memory category',
        },
        importance: { type: 'number', description: 'Importance 0-1', default: 0.5 },
        timeout: { type: 'number', description: 'Timeout in seconds', default: 5 },
      },
      required: ['action'],
    },
  },
  {
    name: 'codemoot_cost',
    description: 'Query cost and token usage data. Supports session, daily, and all-time scopes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        scope: {
          type: 'string',
          enum: ['session', 'daily', 'all'],
          description: 'Cost scope',
          default: 'session',
        },
        sessionId: { type: 'string', description: 'Session ID for session scope' },
        days: { type: 'integer', description: 'Number of days for daily scope', default: 30 },
        timeout: { type: 'number', description: 'Timeout in seconds', default: 5 },
      },
    },
  },
];

export async function startServer(): Promise<void> {
  // Load config
  const projectDir = process.env.CODEMOOT_PROJECT_DIR ?? process.cwd();
  const config: ProjectConfig = loadConfig({ projectDir });

  // Open SQLite (WAL mode + busy_timeout set by openDatabase)
  const dbPath = process.env.CODEMOOT_DB_PATH ?? join(projectDir, '.cowork', 'db', 'cowork.db');
  const db = openDatabase(dbPath);

  // Create model registry and resolve auto mode (pass projectDir for CLI repo awareness)
  const registry = ModelRegistry.fromConfig(config, projectDir);
  await registry.resolveAutoMode();

  // Create orchestrator and stores (pass projectDir for context building)
  const orchestrator = new Orchestrator({ registry, db, config, projectDir });
  const memoryStore = new MemoryStore(db);
  const costStore = new CostStore(db);
  const projectId = config.project.name || 'default';

  // Create MCP server
  const server = new Server(
    { name: 'codemoot', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOL_DEFINITIONS };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments ?? {};

    try {
      switch (toolName) {
        case 'codemoot_review': {
          const token = new CancellationToken();
          return await handleReview(orchestrator, args, token);
        }
        case 'codemoot_plan': {
          return await handlePlan(orchestrator, args);
        }
        case 'codemoot_debate': {
          return await handleDebate(orchestrator, args);
        }
        case 'codemoot_memory': {
          return await handleMemory(memoryStore, projectId, args);
        }
        case 'codemoot_cost': {
          return await handleCost(costStore, args);
        }
        default: {
          return {
            content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
            isError: true,
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown: close db and server on termination signals
  const shutdown = () => {
    try {
      db.close();
    } catch {
      // db may already be closed
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Log to stderr so it does not interfere with stdio MCP transport
  console.error('CodeMoot MCP server started');
}
