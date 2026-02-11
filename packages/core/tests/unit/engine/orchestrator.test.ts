import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock caller module BEFORE imports
vi.mock('../../../src/models/caller.js', () => ({
  callModel: vi.fn(),
  streamModel: vi.fn(),
}));

// Mock DLP sanitize for review/debate tests
vi.mock('../../../src/security/dlp.js', () => ({
  sanitize: vi.fn((input: string) => ({
    sanitized: input.replace(/sk-proj-[a-zA-Z0-9\-_]+/g, '[REDACTED:API_KEY]'),
    redactions: [],
    truncated: false,
    auditLog: [],
  })),
}));

import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { CancellationToken } from '../../../src/engine/cancellation.js';
import { Orchestrator } from '../../../src/engine/orchestrator.js';
import { ArtifactStore } from '../../../src/memory/artifact-store.js';
import { CostStore } from '../../../src/memory/cost-store.js';
import { openDatabase } from '../../../src/memory/database.js';
import { SessionStore } from '../../../src/memory/session-store.js';
import { callModel } from '../../../src/models/caller.js';
import { CliAdapter } from '../../../src/models/cli-adapter.js';
import { sanitize } from '../../../src/security/dlp.js';
import type { ProjectConfig } from '../../../src/types/config.js';
import type { EngineEvent } from '../../../src/types/events.js';

const workflowDir = resolve(__dirname, '../../../../../workflows');

const mockModel = { modelId: 'gpt-5.3-codex', provider: 'openai' } as never;

const mockCliAdapter = Object.create(CliAdapter.prototype);

const mockRegistry = {
  getModelForRole: vi.fn(() => mockModel),
  getAdapterForRole: vi.fn(() => mockModel),
  getModelConfigForRole: vi.fn(() => ({
    provider: 'openai' as const,
    model: 'gpt-5.3-codex',
    maxTokens: 4096,
    temperature: 0.7,
    timeout: 30000,
  })),
  getAdapter: vi.fn(() => mockModel),
  getModelConfig: vi.fn(() => ({
    provider: 'openai' as const,
    model: 'gpt-5.3-codex',
    maxTokens: 4096,
    temperature: 0.7,
    timeout: 30000,
  })),
  isCliMode: vi.fn(() => false),
  listAliases: vi.fn(() => ['codex-architect', 'codex-reviewer']),
};

const testConfig: ProjectConfig = {
  project: { name: 'TestProject', description: 'Test project' },
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

function makeMockCallModel() {
  let callCount = 0;
  return vi.fn(async () => {
    callCount++;
    // Alternate: generate steps return content, review steps return APPROVED
    // Pattern for plan-review-implement workflow:
    // Call 1: plan (generate) -> plan text
    // Call 2: review-plan (review) -> VERDICT: APPROVED
    // Call 3: implement (generate) -> code text
    // Call 4: code-review-loop generate -> code text (re-implement)
    // Call 5: code-review (review) -> VERDICT: APPROVED
    const isEven = callCount % 2 === 0;
    if (isEven) {
      return {
        text: 'Looks good.\n\nVERDICT: APPROVED',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 0.002 },
        finishReason: 'stop',
        durationMs: 300,
      };
    }
    return {
      text: 'Generated content for step',
      model: 'gpt-5.3-codex',
      provider: 'openai',
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300, costUsd: 0.001 },
      finishReason: 'stop',
      durationMs: 500,
    };
  });
}

let db: Database.Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
});

describe('Orchestrator', () => {
  describe('plan()', () => {
    it('creates session and returns plan result', async () => {
      const mock = makeMockCallModel();
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(mock);

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.plan('Build user authentication');

      expect(result.status).toBe('completed');
      expect(result.sessionId).toBeTruthy();
      expect(result.finalOutput).toBe('Generated content for step');
      expect(result.iterations).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('persists session to database', async () => {
      const mock = makeMockCallModel();
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(mock);

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.plan('Build auth');

      const sessionStore = new SessionStore(db);
      const session = sessionStore.get(result.sessionId);

      expect(session).not.toBeNull();
      expect(session?.status).toBe('completed');
      expect(session?.task).toBe('Build auth');
      expect(session?.workflowId).toBe('plan-review-implement');
    });

    it('saves plan artifact', async () => {
      const mock = makeMockCallModel();
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(mock);

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.plan('Build feature');

      const artifactStore = new ArtifactStore(db);
      const artifacts = artifactStore.getBySession(result.sessionId);

      expect(artifacts.length).toBeGreaterThanOrEqual(1);
      expect(artifacts[0].type).toBe('plan');
      expect(artifacts[0].content).toBe('Generated content for step');
    });
  });

  describe('run()', () => {
    it('executes full workflow: plan + implement + code review', async () => {
      const mock = makeMockCallModel();
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(mock);

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.run('Build user authentication');

      expect(result.status).toBe('completed');
      expect(result.sessionId).toBeTruthy();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      // plan loop (2+) + implement (1) + code review loop (2+) = at least 5 calls
      expect(mock.mock.calls.length).toBeGreaterThanOrEqual(5);
    });

    it('persists session with completed status', async () => {
      const mock = makeMockCallModel();
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(mock);

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.run('Build feature');

      const sessionStore = new SessionStore(db);
      const session = sessionStore.get(result.sessionId);

      expect(session).not.toBeNull();
      expect(session?.status).toBe('completed');
    });

    it('records cost log entries', async () => {
      const mock = makeMockCallModel();
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(mock);

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.run('Build feature');

      const costStore = new CostStore(db);
      const entries = costStore.getBySession(result.sessionId);

      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].modelId).toBe('gpt-5.3-codex');
    });

    it('saves multiple artifacts (plan, code, review)', async () => {
      const mock = makeMockCallModel();
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(mock);

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.run('Build feature');

      const artifactStore = new ArtifactStore(db);
      const artifacts = artifactStore.getBySession(result.sessionId);

      // At least plan + code + review artifacts
      expect(artifacts.length).toBeGreaterThanOrEqual(3);
      const types = artifacts.map((a) => a.type);
      expect(types).toContain('plan');
      expect(types).toContain('code');
      expect(types).toContain('review');
    });
  });

  describe('error handling', () => {
    it('returns failed status with error details when model call throws', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API key invalid'));

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.run('Build feature');

      expect(result.status).toBe('failed');
      expect(result.finalOutput).toBe('');
      expect(result.totalCost).toBe(0);
      expect(result.error).toBe('API key invalid');
      expect(result.lastStep).toBeDefined();
    });

    it('marks session as failed in database on error', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.run('Build feature');

      const sessionStore = new SessionStore(db);
      const session = sessionStore.get(result.sessionId);

      expect(session).not.toBeNull();
      expect(session?.status).toBe('failed');
    });

    it('emits session.failed event on error', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Timeout'));

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const events: EngineEvent[] = [];
      orch.on('event', (e) => events.push(e));

      await orch.run('Build feature');

      const failedEvent = events.find((e) => e.type === 'session.failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as { error: string }).error).toBe('Timeout');
    });
  });

  describe('event emission', () => {
    it('emits session.started and session.completed events in order', async () => {
      const mock = makeMockCallModel();
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(mock);

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const events: EngineEvent[] = [];
      orch.on('event', (e) => events.push(e));

      await orch.run('Build feature');

      const types = events.map((e) => e.type);
      expect(types[0]).toBe('session.started');
      expect(types[types.length - 1]).toBe('session.completed');
    });

    it('emits step.started and step.completed events', async () => {
      const mock = makeMockCallModel();
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(mock);

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const events: EngineEvent[] = [];
      orch.on('event', (e) => events.push(e));

      await orch.run('Build feature');

      const stepStarted = events.filter((e) => e.type === 'step.started');
      const stepCompleted = events.filter((e) => e.type === 'step.completed');

      expect(stepStarted.length).toBeGreaterThan(0);
      expect(stepCompleted.length).toBeGreaterThan(0);
    });

    it('emits loop.iteration events during review loops', async () => {
      const mock = makeMockCallModel();
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(mock);

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const events: EngineEvent[] = [];
      orch.on('event', (e) => events.push(e));

      await orch.run('Build feature');

      const loopEvents = events.filter((e) => e.type === 'loop.iteration');
      expect(loopEvents.length).toBeGreaterThan(0);
    });
  });

  describe('options', () => {
    it('respects maxIterations option', async () => {
      // Always return needs_revision to test iteration limit
      let callCount = 0;
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callCount++;
        if (callCount % 2 === 0) {
          return {
            text: 'Issues found.\n\nVERDICT: NEEDS_REVISION',
            model: 'gpt-5.3-codex',
            provider: 'openai',
            usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200, costUsd: 0.001 },
            finishReason: 'stop',
            durationMs: 100,
          };
        }
        return {
          text: 'Generated content',
          model: 'gpt-5.3-codex',
          provider: 'openai',
          usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200, costUsd: 0.001 },
          finishReason: 'stop',
          durationMs: 100,
        };
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.run('Build feature', { maxIterations: 1 });

      // With maxIterations 1, plan loop runs 1 iteration (2 calls: plan + review),
      // then implement (1 call), then code review loop 1 iteration (2 calls: implement + review)
      expect(result.status).toBe('completed');
    });
  });

  describe('review()', () => {
    it('returns ReviewResult with score and verdict APPROVED', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Code quality is excellent. Score: 9/10\n\n- Clean structure\n- Good naming\n\nVERDICT: APPROVED',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 0.002 },
        finishReason: 'stop',
        durationMs: 300,
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.review('function add(a, b) { return a + b; }');

      expect(result.status).toBe('success');
      expect(result.verdict).toBe('approved');
      expect(result.score).toBe(9);
      expect(result.feedback.length).toBeGreaterThan(0);
      expect(result.model).toBe('gpt-5.3-codex');
      expect(result.egressControl).toBe('codemoot-enforced');
    });

    it('returns ReviewResult with NEEDS_REVISION verdict', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Several issues found. Score: 4/10\n\n- Missing error handling\n- No input validation\n\nVERDICT: NEEDS_REVISION',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 200, outputTokens: 150, totalTokens: 350, costUsd: 0.003 },
        finishReason: 'stop',
        durationMs: 400,
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.review('function doStuff(x) { return x; }');

      expect(result.status).toBe('success');
      expect(result.verdict).toBe('needs_revision');
      expect(result.score).toBe(4);
      expect(result.feedback).toContain('Missing error handling');
      expect(result.feedback).toContain('No input validation');
    });

    it('DLP sanitizes content before passing to model', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Looks good.\n\nVERDICT: APPROVED',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 },
        finishReason: 'stop',
        durationMs: 200,
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const contentWithSecret = 'My API key is sk-proj-abc123def456ghi789jkl0 and code is good';
      await orch.review(contentWithSecret);

      // Verify sanitize was called with the content
      expect(sanitize).toHaveBeenCalledWith(contentWithSecret, { mode: 'strict' });

      // Verify callModel received sanitized content (secret replaced)
      const callArgs = (callModel as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[1] as Array<{ role: string; content: string }>;
      expect(messages[0].content).toContain('[REDACTED:API_KEY]');
      expect(messages[0].content).not.toContain('sk-proj-abc123def456ghi789jkl0');
    });

    it('respects custom criteria in review prompt', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'VERDICT: APPROVED',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 },
        finishReason: 'stop',
        durationMs: 200,
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      await orch.review('some code', {
        criteria: ['Check for SQL injection', 'Verify input validation'],
      });

      const callArgs = (callModel as ReturnType<typeof vi.fn>).mock.calls[0];
      const messages = callArgs[1] as Array<{ role: string; content: string }>;
      expect(messages[0].content).toContain('Check for SQL injection');
      expect(messages[0].content).toContain('Verify input validation');
    });

    it('uses default reviewer model when no model specified', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'VERDICT: APPROVED',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 },
        finishReason: 'stop',
        durationMs: 200,
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      await orch.review('some code');

      // Default reviewer alias is 'gpt-5' from testConfig.roles.reviewer.model
      expect(mockRegistry.getAdapter).toHaveBeenCalledWith('codex-reviewer');
    });

    it('respects model override option', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'VERDICT: APPROVED',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 },
        finishReason: 'stop',
        durationMs: 200,
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      await orch.review('some code', { model: 'codex-architect' });

      expect(mockRegistry.getAdapter).toHaveBeenCalledWith('codex-architect');
    });

    it('returns estimated metering for CLI mode', async () => {
      mockRegistry.getAdapter.mockReturnValue(mockCliAdapter);

      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'VERDICT: APPROVED',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0 },
        finishReason: 'stop',
        durationMs: 5000,
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.review('some code');

      expect(result.meteringSource).toBe('estimated');
      expect(result.egressControl).toBe('cli-managed');
    });

    it('returns billed metering for API mode', async () => {
      mockRegistry.getAdapter.mockReturnValue(mockModel);

      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'VERDICT: APPROVED',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 },
        finishReason: 'stop',
        durationMs: 300,
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.review('some code');

      expect(result.meteringSource).toBe('billed');
      expect(result.egressControl).toBe('codemoot-enforced');
    });

    it('throws when cancellation token is already cancelled', async () => {
      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const token = new CancellationToken();
      token.cancel();

      await expect(orch.review('some code', {}, token)).rejects.toThrow('Review cancelled');
      // callModel should NOT have been called
      expect(callModel).not.toHaveBeenCalled();
    });

    it('parses score from "8/10" in response', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Overall quality: 8/10\n\nVERDICT: APPROVED',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 },
        finishReason: 'stop',
        durationMs: 200,
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.review('some code');

      expect(result.score).toBe(8);
    });

    it('deduplicates identical memory auto-saves', async () => {
      const reviewResponse = {
        text: 'Score: 4/10\n\n- Missing error handling\n- No input validation\n\nVERDICT: NEEDS_REVISION',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 200, outputTokens: 150, totalTokens: 350, costUsd: 0.003 },
        finishReason: 'stop',
        durationMs: 400,
      };
      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue(reviewResponse);

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });

      // Review same content twice
      await orch.review('function bad() { return null; }');
      await orch.review('function bad() { return null; }');

      // Check only 1 memory was saved (dedup should prevent second)
      const memories = db.prepare('SELECT * FROM memories WHERE category = ?').all('issue');
      expect(memories.length).toBe(1);
    });
  });

  describe('debate()', () => {
    beforeEach(() => {
      // Reset to default (non-CLI) adapters
      mockRegistry.getAdapter.mockReturnValue(mockModel);
      mockRegistry.isCliMode.mockReturnValue(false);
      mockRegistry.listAliases.mockReturnValue(['codex-architect', 'codex-reviewer']);
      mockRegistry.getModelConfig.mockReturnValue({
        provider: 'openai' as const,
        model: 'gpt-5.3-codex',
            maxTokens: 4096,
        temperature: 0.7,
        timeout: 30000,
      });
    });

    it('returns DebateResult with responses from all models', async () => {
      let callIndex = 0;
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callIndex++;
        return {
          text: `Response from model ${callIndex}`,
          model: 'gpt-5.3-codex',
          provider: 'openai',
          usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200, costUsd: 0.001 },
          finishReason: 'stop',
          durationMs: 300,
        };
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.debate('Should we use REST or GraphQL?');

      expect(result.status).toBe('success');
      expect(result.responses.length).toBe(2);
      expect(result.partialFailure).toBe(false);
      expect(result.egressControl).toBe('codemoot-enforced');
    });

    it('handles partial failure when 1 of 2 models fails', async () => {
      let callIndex = 0;
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callIndex++;
        if (callIndex === 2) {
          throw new Error('Model unavailable');
        }
        return {
          text: `Response from model ${callIndex}`,
          model: 'gpt-5.3-codex',
          provider: 'openai',
          usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200, costUsd: 0.001 },
          finishReason: 'stop',
          durationMs: 300,
        };
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.debate('Should we use REST or GraphQL?');

      expect(result.status).toBe('partial');
      expect(result.responses.length).toBe(2);
      expect(result.partialFailure).toBe(true);
      // One response should have an error
      const errors = result.responses.filter((r) => r.error);
      expect(errors.length).toBe(1);
      expect(errors[0].error).toBe('Model unavailable');
    });

    it('throws when all models fail', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('All down'));

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      await expect(orch.debate('Question?')).rejects.toThrow('All models failed in debate');
    });

    it('DLP sanitizes question before passing to models', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Response',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200, costUsd: 0.001 },
        finishReason: 'stop',
        durationMs: 300,
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const questionWithSecret = 'Using key sk-proj-abc123def456ghi789jkl0 for auth?';
      await orch.debate(questionWithSecret);

      expect(sanitize).toHaveBeenCalledWith(questionWithSecret, { mode: 'strict' });

      // All callModel calls should receive sanitized content
      for (const call of (callModel as ReturnType<typeof vi.fn>).mock.calls) {
        const messages = call[1] as Array<{ role: string; content: string }>;
        expect(messages[0].content).toContain('[REDACTED:API_KEY]');
        expect(messages[0].content).not.toContain('sk-proj-abc123def456ghi789jkl0');
      }
    });

    it('calls synthesizer model when synthesize option is true', async () => {
      let callIndex = 0;
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callIndex++;
        if (callIndex <= 2) {
          return {
            text: `Debate response ${callIndex}`,
            model: 'gpt-5.3-codex',
            provider: 'openai',
            usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200, costUsd: 0.001 },
            finishReason: 'stop',
            durationMs: 300,
          };
        }
        // Third call is the synthesis
        return {
          text: 'Synthesized answer combining both perspectives',
          model: 'gpt-5.3-codex',
          provider: 'openai',
          usage: { inputTokens: 200, outputTokens: 150, totalTokens: 350, costUsd: 0.002 },
          finishReason: 'stop',
          durationMs: 400,
        };
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.debate('REST vs GraphQL?', { synthesize: true });

      expect(result.synthesis).toBe('Synthesized answer combining both perspectives');
      // 2 debate calls + 1 synthesis call = 3
      expect(callIndex).toBe(3);
    });

    it('returns aggregated token usage', async () => {
      (callModel as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'Response',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 },
        finishReason: 'stop',
        durationMs: 300,
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.debate('Question?');

      // 2 models, each with 100 input + 50 output
      expect(result.totalTokenUsage.inputTokens).toBe(200);
      expect(result.totalTokenUsage.outputTokens).toBe(100);
      expect(result.totalTokenUsage.totalTokens).toBe(300);
      expect(result.totalTokenUsage.costUsd).toBeCloseTo(0.002);
    });

    it('returns partial status when some models fail', async () => {
      let callIndex = 0;
      (callModel as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callIndex++;
        if (callIndex === 1) {
          return {
            text: 'Good response',
            model: 'gpt-5.3-codex',
            provider: 'openai',
            usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200, costUsd: 0.001 },
            finishReason: 'stop',
            durationMs: 300,
          };
        }
        throw new Error('Timeout');
      });

      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const result = await orch.debate('Question?');

      expect(result.status).toBe('partial');
      expect(result.partialFailure).toBe(true);
      const successful = result.responses.filter((r) => !r.error);
      expect(successful.length).toBe(1);
    });

    it('throws when cancellation token is already cancelled', async () => {
      const orch = new Orchestrator({
        registry: mockRegistry as never,
        db,
        config: testConfig,
        workflowDir,
      });
      const token = new CancellationToken();
      token.cancel();

      await expect(orch.debate('Question?', {}, token)).rejects.toThrow('Debate cancelled');
      expect(callModel).not.toHaveBeenCalled();
    });
  });
});
