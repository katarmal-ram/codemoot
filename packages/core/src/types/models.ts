// packages/core/src/types/models.ts

import type { ModelProvider } from './config.js';
import type { TokenUsage } from './events.js';
import type { MeteringSource } from './mcp.js';

/**
 * Chat message format. Aligns with Vercel AI SDK's CoreMessage.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallModelOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  /** Timeout in seconds for CLI subprocess calls. Default: 120. */
  timeout?: number;
}

export interface ModelCallResult {
  text: string;
  model: string;
  provider: ModelProvider;
  usage: TokenUsage;
  finishReason: string;
  durationMs: number;
  meteringSource?: MeteringSource;
  /** Codex thread ID for session resume. */
  sessionId?: string;
}

export interface FallbackConfig {
  primary: string;
  fallbacks: string[];
  maxRetries: number;
  retryOn: {
    rateLimit: boolean;
    timeout: boolean;
    serverError: boolean;
  };
}
