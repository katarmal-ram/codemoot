// packages/core/src/types/memory.ts

export type MemoryCategory = 'decision' | 'convention' | 'pattern' | 'issue' | 'preference';

export interface MemoryRecord {
  id?: number;
  projectId: string;
  category: MemoryCategory;
  content: string;
  sourceSessionId: string | null;
  importance: number;
  createdAt: string;
  accessedAt: string;
  accessCount: number;
}

export type ArtifactType = 'plan' | 'code' | 'review' | 'test';

export interface ArtifactRecord {
  id?: number;
  sessionId: string;
  stepId: string;
  iteration: number;
  type: ArtifactType;
  filePath: string | null;
  content: string;
  version: number;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface CostLogEntry {
  id?: number;
  sessionId: string;
  stepId: string | null;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  createdAt: string;
}
