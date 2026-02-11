// packages/core/src/models/caller.ts — CLI-only model caller

import { withCanonicalRetry } from '../security/retry.js';
import type { CallModelOptions, ChatMessage, ModelCallResult } from '../types/models.js';
import { sleep } from '../utils/sleep.js';
import { CliAdapter } from './cli-adapter.js';
import type { ModelAdapter } from './registry.js';

/**
 * Callback for receiving streaming text deltas.
 */
export type TextDeltaEmitter = (delta: string) => void;

/**
 * Unified model call: routes to CLI adapter.
 */
export async function callModel(
  model: ModelAdapter,
  messages: ChatMessage[],
  options?: CallModelOptions,
): Promise<ModelCallResult> {
  return callCliAdapter(model, messages, options);
}

/**
 * Unified streaming model call.
 * CLI: chunked pseudo-streaming (paragraph-split after process completes).
 */
export async function streamModel(
  model: ModelAdapter,
  messages: ChatMessage[],
  onDelta: TextDeltaEmitter,
  _stepId: string,
  _role: string,
  options?: CallModelOptions,
): Promise<ModelCallResult> {
  return streamCliAdapter(model, messages, onDelta, options);
}

async function callCliAdapter(
  adapter: CliAdapter,
  messages: ChatMessage[],
  options?: CallModelOptions,
): Promise<ModelCallResult> {
  const prompt = messagesToPrompt(messages, options?.systemPrompt);
  const timeoutMs = (options?.timeout ?? 600) * 1000;

  const attempt = await withCanonicalRetry(() => adapter.call(prompt, { timeout: timeoutMs }), {
    maxRetries: 2,
    totalAttempts: 3,
    toolTimeoutMs: timeoutMs,
  });

  if (attempt.error || !attempt.result) {
    throw attempt.error ?? new Error('CLI adapter call failed after retries');
  }
  return { ...attempt.result, meteringSource: 'estimated' };
}

async function streamCliAdapter(
  adapter: CliAdapter,
  messages: ChatMessage[],
  onDelta: TextDeltaEmitter,
  options?: CallModelOptions,
): Promise<ModelCallResult> {
  const result = await callCliAdapter(adapter, messages, options);

  const chunks = result.text.split(/\n\n+/).filter(Boolean);
  for (const chunk of chunks) {
    onDelta(`${chunk}\n\n`);
    await sleep(50);
  }

  return result;
}

function messagesToPrompt(messages: ChatMessage[], systemPrompt?: string): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(systemPrompt);
  for (const msg of messages) {
    if (msg.role === 'system') {
      parts.push(msg.content);
    } else {
      parts.push(`${msg.role.toUpperCase()}: ${msg.content}`);
    }
  }
  return parts.join('\n\n');
}

