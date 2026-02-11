// packages/core/src/types/session.ts

import type { ExecutionMode } from './config.js';

export type SessionStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface Session {
  id: string;
  projectId: string;
  workflowId: string;
  task: string;
  status: SessionStatus;
  mode: ExecutionMode;
  currentStep: string | null;
  configSnapshot: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  summary: string | null;
  totalCost: number;
  totalTokens: number;
  metadata: Record<string, unknown>;
}

export interface TranscriptEntry {
  id?: number;
  sessionId: string;
  stepId: string;
  iteration: number | null;
  role: string;
  modelId: string | null;
  content: string;
  tokenCount: number | null;
  cost: number | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}
