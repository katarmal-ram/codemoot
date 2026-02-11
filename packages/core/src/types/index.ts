// packages/core/src/types/index.ts -- barrel re-export

export type {
  ModelProvider,
  ModelConfig,
  RoleConfig,
  DebateConfig,
  DebatePattern,
  MemoryConfig,
  BudgetConfig,
  OutputConfig,
  ProjectConfig,
  ExecutionMode,
  PresetName,
  CliAdapterConfig,
} from './config.js';

export {
  ErrorCode,
  TerminalReason,
  DlpReasonCode,
  reviewInputSchema,
  planInputSchema,
  debateInputSchema,
  memoryInputSchema,
  costInputSchema,
  reviewOutputSchema,
  debateOutputSchema,
} from './mcp.js';
export type {
  ResultStatus,
  MeteringSource,
  ReviewResult,
  DebateResponse,
  DebateResult,
  ReviewInput,
  PlanInput,
  DebateInput,
  MemoryInput,
  CostInput,
} from './mcp.js';

export type {
  WorkflowDefinition,
  StepDefinition,
  StepType,
  LoopConfig,
  ResolvedWorkflow,
  ResolvedStep,
} from './workflow.js';

export type {
  SessionStartedEvent,
  SessionCompletedEvent,
  SessionFailedEvent,
  StepStartedEvent,
  StepCompletedEvent,
  StepFailedEvent,
  TextDeltaEvent,
  TextDoneEvent,
  LoopIterationEvent,
  CostUpdateEvent,
  TokenUsage,
  EngineEvent,
} from './events.js';

export type {
  SessionStatus,
  Session,
  TranscriptEntry,
} from './session.js';

export type {
  MemoryCategory,
  MemoryRecord,
  ArtifactType,
  ArtifactRecord,
  CostLogEntry,
} from './memory.js';

export type {
  ChatMessage,
  CallModelOptions,
  ModelCallResult,
  FallbackConfig,
} from './models.js';

export type {
  BuiltInRole,
  Role,
} from './roles.js';

export type {
  BuildStatus,
  BuildPhase,
  BuildEventType,
  BuildActor,
  BuildRun,
  BuildEvent,
  BuildSummary,
  PhaseCursor,
} from './build.js';

export type {
  CleanupScope,
  CleanupConfidence,
  CleanupSource,
  CleanupFinding,
  CleanupReport,
} from './cleanup.js';

export type {
  DebateId,
  MessageId,
  Stance,
  DebateMessageKind,
  DebateMessage,
  DebateBudget,
  ConvergencePolicy,
  CompactionPolicy,
  DebateEngineInput,
  DebateEngineState,
  DebateEngineResult,
  DebateIO,
  StopReason,
  StopDecision,
} from './debate.js';

export type {
  JobType,
  JobStatus,
  JobRecord,
  JobLogRecord,
  EnqueueOptions,
} from './jobs.js';
