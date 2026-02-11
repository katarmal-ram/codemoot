// packages/core/tests/integration/review-debate.test.ts
// Integration tests for review() and debate() flows.
// Only the model caller is mocked — DLP, verdict parsing, and other internals run for real.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the model caller (actual API/CLI calls)
vi.mock('../../src/models/caller.js', () => ({
  callModel: vi.fn(),
  streamModel: vi.fn(),
}));

import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { migrateConfig } from '../../src/config/migration.js';
import { CancellationToken } from '../../src/engine/cancellation.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { openDatabase } from '../../src/memory/database.js';
import { callModel } from '../../src/models/caller.js';
import { CliAdapter } from '../../src/models/cli-adapter.js';
import type { ProjectConfig } from '../../src/types/config.js';

const workflowDir = resolve(__dirname, '../../../../workflows');

const mockModel = { modelId: 'gpt-5.3-codex', provider: 'openai' } as never;

const mockCliAdapter = Object.create(CliAdapter.prototype);

function makeMockRegistry(overrides?: {
  getAdapter?: ReturnType<typeof vi.fn>;
  isCliMode?: ReturnType<typeof vi.fn>;
}) {
  return {
    getModelForRole: vi.fn(() => mockModel),
    getAdapterForRole: vi.fn(() => mockModel),
    getModelConfigForRole: vi.fn(() => ({
      provider: 'openai' as const,
      model: 'gpt-5.3-codex',
      maxTokens: 4096,
      temperature: 0.7,
      timeout: 30000,
    })),
    getAdapter: overrides?.getAdapter ?? vi.fn(() => mockModel),
    getModelConfig: vi.fn(() => ({
      provider: 'openai' as const,
      model: 'gpt-5.3-codex',
      maxTokens: 4096,
      temperature: 0.7,
      timeout: 30000,
    })),
    isCliMode: overrides?.isCliMode ?? vi.fn(() => false),
    listAliases: vi.fn(() => ['codex-architect', 'codex-reviewer']),
  };
}

const testConfig: ProjectConfig = {
  project: { name: 'ReviewDebateIntegration', description: 'Integration test project' },
  models: {
    'codex-architect': {
      provider: 'openai',
      model: 'gpt-5.3-codex',
      maxTokens: 4096,
      temperature: 0.7,
      timeout: 120,
    },
    'codex-reviewer': {
      provider: 'openai',
      model: 'gpt-5.3-codex',
      maxTokens: 4096,
      temperature: 0.7,
      timeout: 120,
    },
  },
  roles: {
    architect: { model: 'codex-architect', temperature: 0.7, maxTokens: 4096 },
    reviewer: { model: 'codex-reviewer', temperature: 0.3, maxTokens: 4096 },
    implementer: { model: 'codex-architect', temperature: 0.4, maxTokens: 8192 },
  },
  workflow: 'plan-review-implement',
  mode: 'autonomous',
  debate: { defaultPattern: 'proposal-critique', maxRounds: 3, consensusThreshold: 0.7 },
  memory: {
    autoExtractFacts: true,
    contextBudget: { activeContext: 8000, retrievedMemory: 4000, messageBuffer: 2000 },
  },
  budget: { perSession: 5.0, perDay: 25.0, perMonth: 200.0, warningAt: 0.8, action: 'warn' },
  output: {
    saveTranscripts: true,
    transcriptFormat: 'markdown',
    transcriptDir: '.cowork/transcripts',
  },
  advanced: { retryAttempts: 3, stream: false, logLevel: 'info' },
};

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

describe('Integration: review and debate flows', () => {
  describe('review() with real DLP pipeline', () => {
    it('redacts API key in content before passing to model', async () => {
      const registry = makeMockRegistry();

      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Code looks clean.\n\nVERDICT: APPROVED',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 0.002 },
        finishReason: 'stop',
        durationMs: 300,
      });

      const orch = new Orchestrator({
        registry: registry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const content = 'Config uses key sk-proj-abc123def456ghi789jkl0mno to connect';
      const result = await orch.review(content);

      expect(result.status).toBe('success');
      expect(result.verdict).toBe('approved');

      // Verify the model received sanitized content (real DLP ran)
      const callArgs = (callModel as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[1] as Array<{ role: string; content: string }>;
      expect(messages[0].content).not.toContain('sk-proj-abc123def456ghi789jkl0mno');
      expect(messages[0].content).toContain('[REDACTED:API_KEY]');
    });

    it('produces correct verdict from model response via real verdict parser', async () => {
      const registry = makeMockRegistry();

      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Missing error handling in auth module.\nNo rate limiting.\n\nVERDICT: NEEDS_REVISION\nPlease add try-catch blocks.',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 300, outputTokens: 150, totalTokens: 450, costUsd: 0.003 },
        finishReason: 'stop',
        durationMs: 400,
      });

      const orch = new Orchestrator({
        registry: registry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.review('function login(user) { db.query(user); }');

      expect(result.verdict).toBe('needs_revision');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.tokenUsage.inputTokens).toBe(300);
      expect(result.tokenUsage.outputTokens).toBe(150);
    });

    it('DLP strict mode catches API key in review content', async () => {
      const registry = makeMockRegistry();

      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'VERDICT: APPROVED',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 },
        finishReason: 'stop',
        durationMs: 200,
      });

      const orch = new Orchestrator({
        registry: registry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const secretContent =
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0 in header';
      await orch.review(secretContent);

      // Verify model did NOT receive the raw JWT
      const callArgs = (callModel as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[1] as Array<{ role: string; content: string }>;
      // The DLP pipeline should have redacted the Bearer token
      expect(messages[0].content).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    });

    it('cancellation token stops review before model call', async () => {
      const registry = makeMockRegistry();
      const orch = new Orchestrator({
        registry: registry as never,
        db,
        config: testConfig,
        workflowDir,
      });

      const token = new CancellationToken();
      token.cancel();

      await expect(orch.review('some code', {}, token)).rejects.toThrow('Review cancelled');
      expect(callModel).not.toHaveBeenCalled();
    });
  });

  describe('debate() with real DLP pipeline', () => {
    it('returns responses from 2 mock models', async () => {
      const registry = makeMockRegistry();

      let callIndex = 0;
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callIndex++;
        return {
          text: `Model ${callIndex} thinks REST is better for this use case.`,
          model: 'gpt-5.3-codex',
          provider: 'openai',
          usage: { inputTokens: 150, outputTokens: 120, totalTokens: 270, costUsd: 0.0015 },
          finishReason: 'stop',
          durationMs: 350,
        };
      });

      const orch = new Orchestrator({
        registry: registry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.debate('Should we use REST or GraphQL for the new API?');

      expect(result.status).toBe('success');
      expect(result.responses.length).toBe(2);
      expect(result.partialFailure).toBe(false);
      expect(result.egressControl).toBe('codemoot-enforced');
      expect(result.totalTokenUsage.inputTokens).toBe(300);
      expect(result.totalTokenUsage.outputTokens).toBe(240);
    });

    it('returns partial result when 1 of 2 models fails', async () => {
      const registry = makeMockRegistry();

      let callIndex = 0;
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callIndex++;
        if (callIndex === 2) {
          throw new Error('Rate limited');
        }
        return {
          text: `Successful response from model ${callIndex}`,
          model: 'gpt-5.3-codex',
          provider: 'openai',
          usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180, costUsd: 0.001 },
          finishReason: 'stop',
          durationMs: 300,
        };
      });

      const orch = new Orchestrator({
        registry: registry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.debate('Microservices vs monolith?');

      expect(result.status).toBe('partial');
      expect(result.partialFailure).toBe(true);
      expect(result.responses.length).toBe(2);

      const successful = result.responses.filter((r) => !r.error);
      const failed = result.responses.filter((r) => r.error);
      expect(successful.length).toBe(1);
      expect(failed.length).toBe(1);
      expect(failed[0].error).toBe('Rate limited');
    });
  });

  describe('config migration v1 to v2', () => {
    it('produces valid config with configVersion 2', () => {
      const v1Config: ProjectConfig = {
        ...testConfig,
        configVersion: undefined,
      };

      const migrated = migrateConfig(v1Config);

      expect(migrated.configVersion).toBe(2);
      // Original fields should be preserved
      expect(migrated.project.name).toBe('ReviewDebateIntegration');
    });
  });

  describe('CLI adapter detection', () => {
    it('reports cli-managed egress for CLI mode adapter', async () => {
      const cliGetAdapter = vi.fn(() => mockCliAdapter);
      const cliIsCliMode = vi.fn(() => true);
      const registry = makeMockRegistry({
        getAdapter: cliGetAdapter,
        isCliMode: cliIsCliMode,
      });

      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'CLI review output.\n\nVERDICT: APPROVED',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180, costUsd: 0 },
        finishReason: 'stop',
        durationMs: 5000,
      });

      const orch = new Orchestrator({
        registry: registry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.review('some code');

      expect(result.meteringSource).toBe('estimated');
      expect(result.egressControl).toBe('cli-managed');
    });
  });
});
