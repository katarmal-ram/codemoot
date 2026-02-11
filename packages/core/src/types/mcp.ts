// packages/core/src/types/mcp.ts — MCP tool types from approved architecture

import { z } from 'zod';
import { DEFAULT_TIMEOUT_SEC, MCP_CONTENT_MAX_LENGTH, MCP_TASK_MAX_LENGTH, MCP_TIMEOUT_MAX } from '../utils/constants.js';

// -- Error codes from MCP_ARCHITECTURE_APPROVED §12 --
export enum ErrorCode {
  INVALID_INPUT = 'INVALID_INPUT',
  MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE',
  RATE_LIMITED = 'RATE_LIMITED',
  TIMEOUT = 'TIMEOUT',
  DLP_BLOCKED = 'DLP_BLOCKED',
  EGRESS_BLOCKED = 'EGRESS_BLOCKED',
  BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
  CLI_NOT_FOUND = 'CLI_NOT_FOUND',
  CLI_AUTH_FAILED = 'CLI_AUTH_FAILED',
  CANCELLED = 'CANCELLED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export enum TerminalReason {
  COMPLETED = 'COMPLETED',
  TIMEOUT = 'TIMEOUT',
  CANCELLED = 'CANCELLED',
  BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
  MAX_RETRIES = 'MAX_RETRIES',
}

export type ResultStatus = 'success' | 'partial' | 'error';

export enum DlpReasonCode {
  SECRET_DETECTED = 'SECRET_DETECTED',
  HIGH_ENTROPY = 'HIGH_ENTROPY',
  ABSOLUTE_PATH = 'ABSOLUTE_PATH',
  CONTEXT_TRUNCATED = 'CONTEXT_TRUNCATED',
  DECODE_BLOCKED = 'DECODE_BLOCKED',
  BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
}

export type MeteringSource = 'billed' | 'estimated' | 'sdk';

// -- Result interfaces --
export interface ReviewResult {
  status: ResultStatus;
  score: number;
  verdict: 'approved' | 'needs_revision';
  feedback: string[];
  tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
  latencyMs: number;
  meteringSource: MeteringSource;
  model: string;
  egressControl: 'codemoot-enforced' | 'cli-managed';
}

export interface DebateResponse {
  model: string;
  role: string;
  text: string;
  tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
  latencyMs: number;
  meteringSource: MeteringSource;
  error?: string;
}

export interface DebateResult {
  status: ResultStatus;
  responses: DebateResponse[];
  synthesis?: string;
  agreement?: number;
  totalTokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
  partialFailure?: boolean;
  egressControl: 'codemoot-enforced' | 'cli-managed';
}

// -- Zod schemas for MCP tool inputs --
export const reviewInputSchema = z.object({
  content: z.string().min(1).max(MCP_CONTENT_MAX_LENGTH),
  criteria: z.array(z.string()).optional(),
  model: z.string().optional(),
  strict: z.boolean().optional().default(true),
  timeout: z.number().positive().max(MCP_TIMEOUT_MAX).optional().default(DEFAULT_TIMEOUT_SEC),
});
export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const planInputSchema = z.object({
  task: z.string().min(1).max(MCP_TASK_MAX_LENGTH),
  maxRounds: z.number().int().positive().max(10).optional().default(3),
  stream: z.boolean().optional().default(false),
  timeout: z.number().positive().max(MCP_TIMEOUT_MAX).optional().default(DEFAULT_TIMEOUT_SEC),
});
export type PlanInput = z.infer<typeof planInputSchema>;

export const debateInputSchema = z.object({
  question: z.string().min(1).max(MCP_TASK_MAX_LENGTH),
  models: z.array(z.string()).min(1).max(5).optional(),
  synthesize: z.boolean().optional().default(false),
  maxRounds: z.number().int().min(1).max(10).optional().default(3),
  timeout: z.number().positive().max(MCP_TIMEOUT_MAX).optional().default(DEFAULT_TIMEOUT_SEC),
});
export type DebateInput = z.infer<typeof debateInputSchema>;

export const memoryInputSchema = z.object({
  action: z.enum(['save', 'search', 'get', 'delete']),
  content: z.string().optional(),
  query: z.string().optional(),
  memoryId: z.number().int().positive().optional(),
  category: z.enum(['decision', 'convention', 'pattern', 'issue', 'preference']).optional(),
  importance: z.number().min(0).max(1).optional().default(0.5),
  timeout: z.number().positive().max(30).optional().default(5),
});
export type MemoryInput = z.infer<typeof memoryInputSchema>;

export const costInputSchema = z.object({
  scope: z.enum(['session', 'daily', 'all']).optional().default('session'),
  sessionId: z.string().optional(),
  days: z.number().int().positive().max(365).optional().default(30),
  timeout: z.number().positive().max(30).optional().default(5),
});
export type CostInput = z.infer<typeof costInputSchema>;

// -- Zod schemas for MCP tool outputs --
export const reviewOutputSchema = z.object({
  status: z.enum(['success', 'partial', 'error']),
  score: z.number(),
  verdict: z.enum(['approved', 'needs_revision']),
  feedback: z.array(z.string()),
  tokenUsage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
    costUsd: z.number(),
  }),
  latencyMs: z.number(),
  meteringSource: z.enum(['billed', 'estimated', 'sdk']),
  model: z.string(),
  egressControl: z.enum(['codemoot-enforced', 'cli-managed']),
});

export const debateOutputSchema = z.object({
  status: z.enum(['success', 'partial', 'error']),
  responses: z.array(
    z.object({
      model: z.string(),
      role: z.string(),
      text: z.string(),
      tokenUsage: z.object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        totalTokens: z.number(),
        costUsd: z.number(),
      }),
      latencyMs: z.number(),
      meteringSource: z.enum(['billed', 'estimated', 'sdk']),
      error: z.string().optional(),
    }),
  ),
  synthesis: z.string().optional(),
  agreement: z.number().optional(),
  totalTokenUsage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    totalTokens: z.number(),
    costUsd: z.number(),
  }),
  partialFailure: z.boolean().optional(),
  egressControl: z.enum(['codemoot-enforced', 'cli-managed']),
});
