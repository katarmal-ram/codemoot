import { describe, expect, it } from 'vitest';
import { parseCodexJsonl } from '../../../src/models/cli-adapter.js';

describe('parseCodexJsonl', () => {
  it('extracts sessionId from thread.started event', () => {
    const jsonl = '{"type":"thread.started","thread_id":"abc-123"}\n';
    const result = parseCodexJsonl(jsonl);
    expect(result.sessionId).toBe('abc-123');
  });

  it('extracts text from item.completed agent_message events', () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Hello world"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"More text"}}',
    ].join('\n');

    const result = parseCodexJsonl(jsonl);
    expect(result.text).toBe('Hello world\nMore text');
  });

  it('extracts usage from turn.completed event', () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"response"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50,"cached_input_tokens":80}}',
    ].join('\n');

    const result = parseCodexJsonl(jsonl);
    expect(result.usage).toBeDefined();
    expect(result.usage?.inputTokens).toBe(180); // 100 + 80 cached
    expect(result.usage?.outputTokens).toBe(50);
    expect(result.usage?.totalTokens).toBe(230);
    expect(result.usage?.costUsd).toBe(0);
  });

  it('handles empty stdout', () => {
    const result = parseCodexJsonl('');
    expect(result.sessionId).toBeUndefined();
    expect(result.text).toBe('');
    expect(result.usage).toBeUndefined();
  });

  it('skips malformed JSONL lines gracefully', () => {
    const jsonl = [
      '{"type":"thread.started","thread_id":"t1"}',
      'not valid json at all',
      '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
      '{broken',
    ].join('\n');

    const result = parseCodexJsonl(jsonl);
    expect(result.sessionId).toBe('t1');
    expect(result.text).toBe('ok');
  });

  it('ignores non-agent_message item.completed events', () => {
    const jsonl = [
      '{"type":"item.completed","item":{"type":"tool_call","text":"ignored"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"kept"}}',
    ].join('\n');

    const result = parseCodexJsonl(jsonl);
    expect(result.text).toBe('kept');
  });
});

describe('debate engine session tracking', () => {
  it('init state includes sessionIds and resumeStats', async () => {
    const { ProposalCritiqueEngine } = await import('../../../src/engine/debate-engine.js');
    const engine = new ProposalCritiqueEngine();
    const state = engine.init({
      debateId: 'test-1',
      question: 'test question',
      models: ['model-a', 'model-b'],
    });

    expect(state.sessionIds).toEqual({});
    expect(state.resumeStats).toEqual({ attempted: 0, succeeded: 0, fallbacks: 0 });
  });
});

describe('debate_turns table', () => {
  it('creates debate_turns table in schema v2', async () => {
    const { openDatabase } = await import('../../../src/memory/database.js');
    const db = openDatabase(':memory:');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='debate_turns'")
      .all();
    expect(tables).toHaveLength(1);

    // Verify columns
    const info = db.prepare('PRAGMA table_info(debate_turns)').all() as Array<{ name: string }>;
    const colNames = info.map((c) => c.name);
    expect(colNames).toContain('debate_id');
    expect(colNames).toContain('role');
    expect(colNames).toContain('codex_session_id');
    expect(colNames).toContain('status');
    expect(colNames).toContain('state_json');
    expect(colNames).toContain('resume_fail_count');

    db.close();
  });
});
