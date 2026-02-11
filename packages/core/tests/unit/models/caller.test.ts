import { describe, expect, it, vi } from 'vitest';
import { callModel, streamModel } from '../../../src/models/caller.js';
import { CliAdapter } from '../../../src/models/cli-adapter.js';
import type { ChatMessage } from '../../../src/types/models.js';

// Mock the retry module to pass through directly
vi.mock('../../../src/security/retry.js', () => ({
  withCanonicalRetry: vi.fn(async (fn: () => Promise<unknown>) => {
    const result = await fn();
    return { result, error: null };
  }),
}));

// Create a mock CliAdapter
function createMockAdapter(): CliAdapter {
  const adapter = new CliAdapter({
    command: 'codex',
    args: ['exec'],
    provider: 'openai',
    model: 'gpt-5.3-codex',
    cliName: 'codex',
  });
  // Mock the call method
  vi.spyOn(adapter, 'call').mockResolvedValue({
    text: 'CLI response text',
    model: 'gpt-5.3-codex',
    provider: 'openai',
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0 },
    finishReason: 'stop',
    durationMs: 500,
  });
  return adapter;
}

describe('callModel', () => {
  it('returns a ModelCallResult with correct shape', async () => {
    const adapter = createMockAdapter();
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await callModel(adapter, messages);

    expect(result.text).toBe('CLI response text');
    expect(result.model).toBe('gpt-5.3-codex');
    expect(result.provider).toBe('openai');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.meteringSource).toBe('estimated');
  });

  it('concatenates messages into prompt', async () => {
    const adapter = createMockAdapter();
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
    ];
    await callModel(adapter, messages);

    expect(adapter.call).toHaveBeenCalledWith(
      expect.stringContaining('You are helpful'),
      expect.any(Object),
    );
    expect(adapter.call).toHaveBeenCalledWith(
      expect.stringContaining('USER: Hello'),
      expect.any(Object),
    );
  });

  it('includes systemPrompt in prompt', async () => {
    const adapter = createMockAdapter();
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
    await callModel(adapter, messages, { systemPrompt: 'Base system prompt' });

    expect(adapter.call).toHaveBeenCalledWith(
      expect.stringContaining('Base system prompt'),
      expect.any(Object),
    );
  });
});

describe('streamModel', () => {
  it('emits text deltas via callback (chunked pseudo-streaming)', async () => {
    const adapter = createMockAdapter();
    // Mock response with paragraph breaks for chunking
    vi.spyOn(adapter, 'call').mockResolvedValue({
      text: 'First paragraph\n\nSecond paragraph',
      model: 'gpt-5.3-codex',
      provider: 'openai',
      usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110, costUsd: 0 },
      finishReason: 'stop',
      durationMs: 300,
    });

    const deltas: string[] = [];
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
    await streamModel(adapter, messages, (d) => deltas.push(d), 'step-1', 'architect');

    expect(deltas.length).toBe(2);
    expect(deltas[0]).toContain('First paragraph');
    expect(deltas[1]).toContain('Second paragraph');
  });

  it('returns complete ModelCallResult', async () => {
    const adapter = createMockAdapter();
    const messages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];
    const result = await streamModel(adapter, messages, () => {}, 'step-1', 'architect');

    expect(result.text).toBe('CLI response text');
    expect(result.provider).toBe('openai');
    expect(result.meteringSource).toBe('estimated');
  });
});
