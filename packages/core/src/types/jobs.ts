// packages/core/src/types/jobs.ts — Job queue types for background async work

export type JobType = 'review' | 'cleanup' | 'build-review' | 'composite' | 'watch-review';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface JobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: number;
  dedupeKey: string | null;
  payloadJson: string;
  resultJson: string | null;
  errorText: string | null;
  retryCount: number;
  maxRetries: number;
  sessionId: string | null;
  workerId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobLogRecord {
  id: number;
  jobId: string;
  seq: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  eventType: string;
  message: string | null;
  payloadJson: string | null;
  createdAt: number;
}

export interface EnqueueOptions {
  type: JobType;
  payload: Record<string, unknown>;
  priority?: number;
  dedupeKey?: string;
  sessionId?: string;
  maxRetries?: number;
}
