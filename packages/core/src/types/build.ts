// packages/core/src/types/build.ts — Build loop types

export type BuildStatus =
  | 'planning'
  | 'implementing'
  | 'reviewing'
  | 'fixing'
  | 'completed'
  | 'failed'
  | 'paused';

export type BuildPhase =
  | 'debate'
  | 'plan_approved'
  | 'implementing'
  | 'review'
  | 'fix'
  | 'done';

export type BuildEventType =
  | 'debate_started'
  | 'debate_converged'
  | 'plan_approved'
  | 'impl_started'
  | 'impl_completed'
  | 'review_requested'
  | 'review_verdict'
  | 'bug_found'
  | 'fix_started'
  | 'fix_completed'
  | 'phase_transition'
  | 'error'
  | 'resumed'
  | 'scan_completed'
  | 'merge_completed'
  | 'adjudicated';

export type BuildActor = 'claude' | 'codex' | 'system';

export interface BuildRun {
  id: number;
  buildId: string;
  task: string;
  status: BuildStatus;
  currentPhase: BuildPhase;
  currentLoop: number;
  lastEventSeq: number;
  phaseCursor: PhaseCursor;
  debateId: string | null;
  baselineRef: string | null;
  planCodexSession: string | null;
  reviewCodexSession: string | null;
  planVersion: number;
  reviewCycles: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  metadata: Record<string, unknown> | null;
}

export interface PhaseCursor {
  phase: BuildPhase;
  loop: number;
  actor: BuildActor;
  attempt: number;
  lastEventId: number;
  baselineRef?: string;
}

export interface BuildEvent {
  id: number;
  buildId: string;
  seq: number;
  eventType: BuildEventType;
  actor: BuildActor;
  phase: BuildPhase;
  loopIndex: number;
  payload: Record<string, unknown> | null;
  codexThreadId: string | null;
  tokensUsed: number;
  createdAt: number;
}

export interface BuildSummary {
  buildId: string;
  task: string;
  status: BuildStatus;
  phase: BuildPhase;
  loop: number;
  reviewCycles: number;
  planVersion: number;
  debateId: string | null;
  baselineRef: string | null;
  createdAt: number;
  updatedAt: number;
}
