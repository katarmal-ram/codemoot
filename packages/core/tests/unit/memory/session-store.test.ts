import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { openDatabase } from '../../../src/memory/database.js';
import { SessionStore } from '../../../src/memory/session-store.js';

let db: Database.Database;
let store: SessionStore;

beforeEach(() => {
  db = openDatabase(':memory:');
  store = new SessionStore(db);
});

afterEach(() => {
  db.close();
});

describe('SessionStore', () => {
  it('creates a session with generated ID', () => {
    const session = store.create({
      projectId: 'test-project',
      workflowId: 'plan-review',
      task: 'Add auth',
      mode: 'autonomous',
      config: DEFAULT_CONFIG,
    });
    expect(session.id).toMatch(/^ses_/);
    expect(session.status).toBe('running');
    expect(session.task).toBe('Add auth');
    expect(session.totalCost).toBe(0);
  });

  it('retrieves a session by ID', () => {
    const created = store.create({
      projectId: 'test-project',
      workflowId: 'plan-review',
      task: 'Fix bug',
      mode: 'interactive',
      config: DEFAULT_CONFIG,
    });
    const fetched = store.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.task).toBe('Fix bug');
    expect(fetched?.mode).toBe('interactive');
  });

  it('returns null for non-existent session', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  it('lists sessions with filters', () => {
    store.create({
      projectId: 'p1',
      workflowId: 'w',
      task: 'a',
      mode: 'autonomous',
      config: DEFAULT_CONFIG,
    });
    store.create({
      projectId: 'p1',
      workflowId: 'w',
      task: 'b',
      mode: 'autonomous',
      config: DEFAULT_CONFIG,
    });
    store.create({
      projectId: 'p2',
      workflowId: 'w',
      task: 'c',
      mode: 'autonomous',
      config: DEFAULT_CONFIG,
    });

    expect(store.list({ projectId: 'p1' })).toHaveLength(2);
    expect(store.list({ projectId: 'p2' })).toHaveLength(1);
    expect(store.list({ limit: 2 })).toHaveLength(2);
    expect(store.list()).toHaveLength(3);
  });

  it('updates session status', () => {
    const session = store.create({
      projectId: 'p',
      workflowId: 'w',
      task: 't',
      mode: 'autonomous',
      config: DEFAULT_CONFIG,
    });
    store.updateStatus(session.id, 'paused');
    expect(store.get(session.id)?.status).toBe('paused');
  });

  it('updates current step', () => {
    const session = store.create({
      projectId: 'p',
      workflowId: 'w',
      task: 't',
      mode: 'autonomous',
      config: DEFAULT_CONFIG,
    });
    store.updateCurrentStep(session.id, 'review-plan');
    expect(store.get(session.id)?.currentStep).toBe('review-plan');
  });

  it('completes a session with summary', () => {
    const session = store.create({
      projectId: 'p',
      workflowId: 'w',
      task: 't',
      mode: 'autonomous',
      config: DEFAULT_CONFIG,
    });
    store.complete(session.id, 'Done successfully');
    const completed = store.get(session.id);
    expect(completed).not.toBeNull();
    expect(completed?.status).toBe('completed');
    expect(completed?.summary).toBe('Done successfully');
    expect(completed?.completedAt).not.toBeNull();
  });

  it('adds usage (cost + tokens)', () => {
    const session = store.create({
      projectId: 'p',
      workflowId: 'w',
      task: 't',
      mode: 'autonomous',
      config: DEFAULT_CONFIG,
    });
    store.addUsage(session.id, 0.05, 1000);
    store.addUsage(session.id, 0.03, 500);
    const updated = store.get(session.id);
    expect(updated).not.toBeNull();
    expect(updated?.totalCost).toBeCloseTo(0.08);
    expect(updated?.totalTokens).toBe(1500);
  });

  it('saves and retrieves transcript entries', () => {
    const session = store.create({
      projectId: 'p',
      workflowId: 'w',
      task: 't',
      mode: 'autonomous',
      config: DEFAULT_CONFIG,
    });
    store.saveTranscriptEntry({
      sessionId: session.id,
      stepId: 'plan',
      role: 'architect',
      modelId: 'claude-sonnet-4-5',
      content: 'Here is the plan...',
      tokenCount: 500,
      createdAt: new Date().toISOString(),
      metadata: null,
    });
    store.saveTranscriptEntry({
      sessionId: session.id,
      stepId: 'review',
      role: 'reviewer',
      modelId: 'gpt-5',
      content: 'VERDICT: APPROVED',
      tokenCount: 100,
      createdAt: new Date().toISOString(),
      metadata: null,
    });

    const transcript = store.getTranscript(session.id);
    expect(transcript).toHaveLength(2);
    expect(transcript[0].role).toBe('architect');
    expect(transcript[1].role).toBe('reviewer');
  });

  it('filters sessions by status', () => {
    const s1 = store.create({
      projectId: 'p',
      workflowId: 'w',
      task: 'a',
      mode: 'autonomous',
      config: DEFAULT_CONFIG,
    });
    store.create({
      projectId: 'p',
      workflowId: 'w',
      task: 'b',
      mode: 'autonomous',
      config: DEFAULT_CONFIG,
    });
    store.complete(s1.id);

    expect(store.list({ status: 'completed' })).toHaveLength(1);
    expect(store.list({ status: 'running' })).toHaveLength(1);
  });
});
