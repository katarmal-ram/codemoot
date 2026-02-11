// packages/core/src/models/bridge.ts — Generic bridge interface for CLI-to-CLI communication

import type { ModelCallResult } from '../types/models.js';
import type { ProgressCallbacks } from './cli-adapter.js';

/** Capabilities that a bridge implementation advertises. */
export interface BridgeCapabilities {
  /** Whether the bridge supports session resume (multi-turn statefulness). */
  supportsResume: boolean;
  /** Whether the bridge supports streaming output. */
  supportsStream: boolean;
  /** Maximum context window in tokens. */
  maxContextTokens: number;
  /** Whether the bridge can use tools (read files, run commands). */
  supportsTools: boolean;
  /** Whether the bridge can access the project working directory. */
  supportsCwd: boolean;
}

/** Options for a bridge send/resume call. */
export interface BridgeOptions extends ProgressCallbacks {
  timeout?: number;
  maxOutputBytes?: number;
  idleTimeout?: number;
}

/** Options for a bridge resume call. */
export interface BridgeResumeOptions extends BridgeOptions {
  sessionId: string;
}

/**
 * Generic interface for bridging communication between two CLI tools.
 * Each implementation handles its own CLI's quirks (JSONL parsing, session format, auth).
 */
export interface CliBridge {
  /** Human-readable bridge name (e.g., 'codex', 'gemini', 'claude'). */
  readonly name: string;
  /** Model identifier. */
  readonly model: string;
  /** Advertised capabilities. */
  readonly capabilities: BridgeCapabilities;
  /** Send a prompt and get a response. */
  send(prompt: string, options?: BridgeOptions): Promise<ModelCallResult>;
  /** Resume a previous session with a new prompt. Falls back to send() if resume unsupported. */
  resume(sessionId: string, prompt: string, options?: BridgeOptions): Promise<ModelCallResult>;
}
