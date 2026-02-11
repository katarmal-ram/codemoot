// packages/core/src/types/events.ts

/**
 * AG-UI compatible event types.
 * Emitted by the core engine and consumed by CLI / Web.
 * Type names follow AG-UI convention (dot-separated).
 */

// -- Lifecycle events --
export interface SessionStartedEvent {
  type: 'session.started';
  sessionId: string;
  workflow: string;
  task: string;
  timestamp: string;
}

export interface SessionCompletedEvent {
  type: 'session.completed';
  sessionId: string;
  finalOutput: string;
  totalCost: number;
  totalTokens: number;
  durationMs: number;
  timestamp: string;
}

export interface SessionFailedEvent {
  type: 'session.failed';
  sessionId: string;
  error: string;
  lastStep: string;
  timestamp: string;
}

// -- Step events --
export interface StepStartedEvent {
  type: 'step.started';
  stepId: string;
  role: string;
  model: string;
  iteration: number;
  timestamp: string;
}

export interface StepCompletedEvent {
  type: 'step.completed';
  stepId: string;
  output: string;
  tokenUsage: TokenUsage;
  durationMs: number;
  timestamp: string;
}

export interface StepFailedEvent {
  type: 'step.failed';
  stepId: string;
  error: string;
  retriesExhausted: boolean;
  timestamp: string;
}

// -- Streaming events --
export interface TextDeltaEvent {
  type: 'text.delta';
  stepId: string;
  role: string;
  delta: string;
}

export interface TextDoneEvent {
  type: 'text.done';
  stepId: string;
  role: string;
  fullText: string;
}

// -- Loop events --
export interface LoopIterationEvent {
  type: 'loop.iteration';
  stepId: string;
  iteration: number;
  maxIterations: number;
  verdict: 'approved' | 'needs_revision';
  feedback?: string;
  timestamp: string;
}

// -- Cost events --
export interface CostUpdateEvent {
  type: 'cost.update';
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cumulativeSessionCost: number;
  timestamp: string;
}

// -- Token usage (shared) --
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

// -- Union type --
export type EngineEvent =
  | SessionStartedEvent
  | SessionCompletedEvent
  | SessionFailedEvent
  | StepStartedEvent
  | StepCompletedEvent
  | StepFailedEvent
  | TextDeltaEvent
  | TextDoneEvent
  | LoopIterationEvent
  | CostUpdateEvent;
