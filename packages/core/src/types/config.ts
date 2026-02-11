// packages/core/src/types/config.ts

export type ModelProvider = 'openai';

export interface CliAdapterConfig {
  command: string;
  args: string[];
  timeout: number;
  outputFile?: string;
  maxOutputBytes?: number;
  envAllowlist?: string[];
}

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  maxTokens: number;
  temperature: number;
  timeout: number;
  cliAdapter?: CliAdapterConfig;
}

export interface RoleConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  systemPromptFile?: string;
}

export interface DebateConfig {
  defaultPattern: DebatePattern;
  maxRounds: number;
  consensusThreshold: number;
}

export type DebatePattern =
  | 'structured-rounds'
  | 'proposal-critique'
  | 'free-flowing'
  | 'parallel-panel';

export interface MemoryConfig {
  embeddingModel?: string;
  autoExtractFacts: boolean;
  contextBudget: {
    activeContext: number;
    retrievedMemory: number;
    messageBuffer: number;
  };
}

export interface BudgetConfig {
  perSession: number;
  perDay: number;
  perMonth: number;
  warningAt: number;
  action: 'warn' | 'pause' | 'block';
}

export interface OutputConfig {
  saveTranscripts: boolean;
  transcriptFormat: 'markdown' | 'json';
  transcriptDir: string;
}

export interface ProjectConfig {
  configVersion?: number;
  project: {
    name: string;
    description: string;
  };
  models: Record<string, ModelConfig>;
  roles: Record<string, RoleConfig>;
  workflow: string;
  mode: ExecutionMode;
  debate: DebateConfig;
  memory: MemoryConfig;
  budget: BudgetConfig;
  output: OutputConfig;
  advanced: {
    retryAttempts: number;
    stream: boolean;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
  };
}

export type ExecutionMode = 'autonomous' | 'interactive' | 'dashboard';
export type PresetName = 'cli-first';
