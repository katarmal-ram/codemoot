// packages/core/tests/integration/plan-review-loop.test.ts
// Full workflow integration test with mocked providers

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock caller module BEFORE imports
vi.mock('../../src/models/caller.js', () => ({
  callModel: vi.fn(),
  streamModel: vi.fn(),
}));

import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { ArtifactStore } from '../../src/memory/artifact-store.js';
import { CostStore } from '../../src/memory/cost-store.js';
import { openDatabase } from '../../src/memory/database.js';
import { SessionStore } from '../../src/memory/session-store.js';
import { callModel } from '../../src/models/caller.js';
import type { ProjectConfig } from '../../src/types/config.js';
import type { EngineEvent } from '../../src/types/events.js';

const workflowDir = resolve(__dirname, '../../../../workflows');

const mockModel = { modelId: 'gpt-5.3-codex', provider: 'openai' } as never;

const mockRegistry = {
  getModelForRole: vi.fn(() => mockModel),
  getAdapterForRole: vi.fn(() => mockModel),
  getModelConfigForRole: vi.fn(() => ({
    provider: 'openai' as const,
    model: 'gpt-5.3-codex',
    maxTokens: 4096,
    temperature: 0.7,
    timeout: 120,
  })),
};

const testConfig: ProjectConfig = {
  project: { name: 'IntegrationTest', description: 'Integration test project' },
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

describe('Integration: plan-review-implement workflow', () => {
  it('runs full plan -> review (approved) -> implement -> code-review (approved) flow', async () => {
    (callModel as ReturnType<typeof vi.fn>).mockImplementation(
      async (_model: unknown, messages: { role: string; content: string }[]) => {
        // Detect review steps by checking for review-related content in messages
        const allContent = messages.map((m) => m.content).join(' ');
        const isReview = allContent.includes('Review') || allContent.includes('review');
        if (isReview) {
          return {
            text: 'The implementation is solid.\n\nVERDICT: APPROVED',
            model: 'mock-reviewer',
            provider: 'openai',
            usage: { inputTokens: 300, outputTokens: 150, totalTokens: 450, costUsd: 0.003 },
            finishReason: 'stop',
            durationMs: 400,
          };
        }
        return {
          text: 'Generated content for this step',
          model: 'mock-architect',
          provider: 'openai',
          usage: { inputTokens: 200, outputTokens: 500, totalTokens: 700, costUsd: 0.005 },
          finishReason: 'stop',
          durationMs: 600,
        };
      },
    );

    const events: EngineEvent[] = [];
    const orch = new Orchestrator({
      registry: mockRegistry as never,
      db,
      config: testConfig,
      workflowDir,
    });
    orch.on('event', (e) => events.push(e));

    const result = await orch.run('Add a REST endpoint for user registration');

    // 1. Verify overall result
    expect(result.status).toBe('completed');
    expect(result.sessionId).toBeTruthy();
    expect(result.finalOutput).toBeTruthy();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // 2. Verify event emission order matches sequence diagram
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes[0]).toBe('session.started');
    expect(eventTypes[eventTypes.length - 1]).toBe('session.completed');

    // Should have step.started and step.completed pairs
    const stepStarted = events.filter((e) => e.type === 'step.started');
    const stepCompleted = events.filter((e) => e.type === 'step.completed');
    expect(stepStarted.length).toBeGreaterThan(0);
    expect(stepCompleted.length).toBe(stepStarted.length);

    // Should have loop.iteration events
    const loopEvents = events.filter((e) => e.type === 'loop.iteration');
    expect(loopEvents.length).toBeGreaterThanOrEqual(2); // plan loop + code review loop

    // All loop.iteration events should be 'approved' (first attempt each time)
    for (const e of loopEvents) {
      if (e.type === 'loop.iteration') {
        expect(e.verdict).toBe('approved');
      }
    }

    // 3. Verify session persisted correctly
    const sessionStore = new SessionStore(db);
    const session = sessionStore.get(result.sessionId);
    expect(session).not.toBeNull();
    expect(session?.status).toBe('completed');
    expect(session?.task).toBe('Add a REST endpoint for user registration');

    // 4. Verify transcript saved
    const transcript = sessionStore.getTranscript(result.sessionId);
    expect(transcript.length).toBeGreaterThan(0);
    // Each model call saves a transcript entry
    expect(transcript.length).toBeGreaterThan(0);

    // 5. Verify artifacts saved (plan + code + review)
    const artifactStore = new ArtifactStore(db);
    const artifacts = artifactStore.getBySession(result.sessionId);
    expect(artifacts.length).toBeGreaterThanOrEqual(3);
    const artifactTypes = artifacts.map((a) => a.type);
    expect(artifactTypes).toContain('plan');
    expect(artifactTypes).toContain('code');
    expect(artifactTypes).toContain('review');

    // 6. Verify cost logged
    const costStore = new CostStore(db);
    const costEntries = costStore.getBySession(result.sessionId);
    expect(costEntries.length).toBeGreaterThan(0);
    expect(costEntries[0].inputTokens).toBeGreaterThan(0);

    const costSummary = costStore.getSessionSummary(result.sessionId);
    expect(costSummary.length).toBeGreaterThan(0);
  });

  it('plan-only mode runs only plan + review without implement', async () => {
    let callIndex = 0;
    (callModel as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callIndex++;
      if (callIndex % 2 === 0) {
        return {
          text: 'VERDICT: APPROVED\nGood plan.',
          model: 'mock-model',
          provider: 'openai',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.001 },
          finishReason: 'stop',
          durationMs: 200,
        };
      }
      return {
        text: '## Plan\n1. Create endpoint\n2. Add validation\n3. Write tests',
        model: 'gpt-5.3-codex',
        provider: 'openai',
        usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300, costUsd: 0.002 },
        finishReason: 'stop',
        durationMs: 400,
      };
    });

    const events: EngineEvent[] = [];
    const orch = new Orchestrator({
      registry: mockRegistry as never,
      db,
      config: testConfig,
      workflowDir,
    });
    orch.on('event', (e) => events.push(e));

    const result = await orch.plan('Design user auth system');

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(1);
    // Only 2 calls: plan + review (no implement, no code review)
    expect(callIndex).toBe(2);

    // Verify events
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes[0]).toBe('session.started');
    expect(eventTypes[eventTypes.length - 1]).toBe('session.completed');

    // Only 1 loop event (plan review, no code review loop)
    const loopEvents = events.filter((e) => e.type === 'loop.iteration');
    expect(loopEvents.length).toBe(1);
  });

  it('handles review loop with revision (needs_revision then approved)', async () => {
    let callIndex = 0;
    (callModel as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callIndex++;
      // Plan calls: 1=generate, 2=review(NEEDS_REVISION), 3=revise, 4=review(APPROVED)
      switch (callIndex) {
        case 1:
          return {
            text: 'Initial plan v1',
            model: 'mock-model',
            provider: 'openai',
            usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300, costUsd: 0.002 },
            finishReason: 'stop',
            durationMs: 500,
          };
        case 2:
          return {
            text: 'Missing error handling.\n\nVERDICT: NEEDS_REVISION\nAdd try-catch blocks.',
            model: 'mock-model',
            provider: 'openai',
            usage: { inputTokens: 300, outputTokens: 100, totalTokens: 400, costUsd: 0.003 },
            finishReason: 'stop',
            durationMs: 400,
          };
        case 3:
          return {
            text: 'Revised plan v2 with error handling',
            model: 'mock-model',
            provider: 'openai',
            usage: { inputTokens: 200, outputTokens: 300, totalTokens: 500, costUsd: 0.004 },
            finishReason: 'stop',
            durationMs: 600,
          };
        case 4:
          return {
            text: 'VERDICT: APPROVED\nGood revision.',
            model: 'mock-model',
            provider: 'openai',
            usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350, costUsd: 0.002 },
            finishReason: 'stop',
            durationMs: 300,
          };
        default:
          return {
            text: 'Default mock response',
            model: 'mock-model',
            provider: 'openai',
            usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100, costUsd: 0.001 },
            finishReason: 'stop',
            durationMs: 100,
          };
      }
    });

    const events: EngineEvent[] = [];
    const orch = new Orchestrator({
      registry: mockRegistry as never,
      db,
      config: testConfig,
      workflowDir,
    });
    orch.on('event', (e) => events.push(e));

    const result = await orch.plan('Build auth', { maxRounds: 3 });

    expect(result.status).toBe('completed');
    expect(result.iterations).toBe(2); // 2 iterations of the plan loop

    // Verify loop events show the revision
    const loopEvents = events.filter((e) => e.type === 'loop.iteration');
    expect(loopEvents.length).toBe(2);
    if (loopEvents[0].type === 'loop.iteration') {
      expect(loopEvents[0].verdict).toBe('needs_revision');
    }
    if (loopEvents[1].type === 'loop.iteration') {
      expect(loopEvents[1].verdict).toBe('approved');
    }

    // Verify final output is the revised plan
    expect(result.finalOutput).toBe('Revised plan v2 with error handling');
  });
});
