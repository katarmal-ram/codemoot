// packages/core/src/types/debate.ts — Debate Engine types

export type DebateId = string;
export type MessageId = string;

/** Stance a debater takes relative to the current proposal. */
export type Stance = 'support' | 'oppose' | 'uncertain';

/** Message types in a debate thread. */
export type DebateMessageKind =
  | 'topic' // initial question
  | 'proposal' // architect's plan/answer
  | 'critique' // reviewer's critique
  | 'rebuttal' // response to critique
  | 'summary' // moderator's round summary
  | 'verdict'; // final synthesized answer

/** A single message in the debate thread. */
export interface DebateMessage {
  id: MessageId;
  turn: number;
  round: number;
  speakerId: string; // model alias or 'moderator'
  kind: DebateMessageKind;
  text: string;
  replyTo?: MessageId;
  stance?: Stance;
  confidence?: number; // 0..1
  tokens?: { prompt: number; completion: number };
  createdAt: number;
}

/** Budget constraints for a debate. */
export interface DebateBudget {
  maxRounds: number; // default 3, max 10
  maxWallClockMs: number; // default 110_000 (under CLI 120s limit)
  perTurnTimeoutMs: number; // default 60_000
}

/** Convergence detection config. */
export interface ConvergencePolicy {
  /** Min rounds before checking convergence. */
  minRoundsBeforeCheck: number; // default 1
  /** Stop if stance unchanged for N consecutive rounds. */
  requiredStableRounds: number; // default 2
}

/** Context compaction config. */
export interface CompactionPolicy {
  /** Number of recent messages to keep in full. */
  keepRecentMessages: number; // default 4
  /** Max tokens for the summary. */
  summaryMaxTokens: number; // default 500
}

/** Input to start a debate. */
export interface DebateEngineInput {
  debateId: DebateId;
  question: string;
  /** Model aliases to use as debaters. First = proposer, second = critic. */
  models: string[];
  budget?: Partial<DebateBudget>;
  convergence?: Partial<ConvergencePolicy>;
  compaction?: Partial<CompactionPolicy>;
}

/** Mutable state of an ongoing debate. */
export interface DebateEngineState {
  debateId: DebateId;
  question: string;
  models: string[];
  round: number;
  turn: number;
  thread: DebateMessage[];
  runningSummary: string;
  stanceHistory: Array<{ round: number; speakerId: string; stance: Stance }>;
  usage: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCalls: number;
    startedAt: number;
  };
  status: 'running' | 'stopped';
  /** Codex session IDs per speaker for resume. */
  sessionIds: Record<string, string>;
  /** Resume telemetry. */
  resumeStats: { attempted: number; succeeded: number; fallbacks: number };
}

/** Why the debate stopped. */
export type StopReason = 'converged' | 'max_rounds' | 'time_budget' | 'error';

export interface StopDecision {
  stop: boolean;
  reason?: StopReason;
  diagnostics?: {
    stableRounds?: number;
    elapsedMs?: number;
    remainingMs?: number;
  };
}

/** What the caller needs to implement: call a model with a prompt. */
export interface DebateIO {
  generate(
    modelAlias: string,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    timeoutMs: number,
    sessionId?: string,
  ): Promise<{ text: string; promptTokens: number; completionTokens: number; sessionId?: string }>;
}

/** Final result of a debate. */
export interface DebateEngineResult {
  debateId: DebateId;
  answer: string;
  reason: StopReason;
  rounds: number;
  thread: DebateMessage[];
  stanceHistory: DebateEngineState['stanceHistory'];
  usage: DebateEngineState['usage'];
}
