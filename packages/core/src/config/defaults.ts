// packages/core/src/config/defaults.ts

import type { ProjectConfig } from '../types/config.js';
import { CONTEXT_ACTIVE, CONTEXT_BUFFER, CONTEXT_RETRIEVED, DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_SEC, IMPLEMENTER_MAX_TOKENS } from '../utils/constants.js';

export const DEFAULT_CONFIG: ProjectConfig = {
  project: {
    name: '',
    description: '',
  },
  models: {
    'codex-architect': {
      provider: 'openai',
      model: 'gpt-5.3-codex',
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: 0.7,
      timeout: DEFAULT_TIMEOUT_SEC,
    },
    'codex-reviewer': {
      provider: 'openai',
      model: 'gpt-5.3-codex',
      maxTokens: DEFAULT_MAX_TOKENS,
      temperature: 0.3,
      timeout: DEFAULT_TIMEOUT_SEC,
    },
  },
  roles: {
    architect: {
      model: 'codex-architect',
      temperature: 0.7,
      maxTokens: DEFAULT_MAX_TOKENS,
    },
    reviewer: {
      model: 'codex-reviewer',
      temperature: 0.3,
      maxTokens: DEFAULT_MAX_TOKENS,
    },
    implementer: {
      model: 'codex-architect',
      temperature: 0.4,
      maxTokens: IMPLEMENTER_MAX_TOKENS,
    },
  },
  workflow: 'plan-review-implement',
  mode: 'autonomous',
  debate: {
    defaultPattern: 'proposal-critique',
    maxRounds: 3,
    consensusThreshold: 0.7,
  },
  memory: {
    autoExtractFacts: true,
    contextBudget: {
      activeContext: CONTEXT_ACTIVE,
      retrievedMemory: CONTEXT_RETRIEVED,
      messageBuffer: CONTEXT_BUFFER,
    },
  },
  budget: {
    perSession: 5.0,
    perDay: 25.0,
    perMonth: 200.0,
    warningAt: 0.8,
    action: 'warn',
  },
  output: {
    saveTranscripts: true,
    transcriptFormat: 'markdown',
    transcriptDir: '.cowork/transcripts',
  },
  advanced: {
    retryAttempts: 3,
    stream: true,
    logLevel: 'info',
  },
};
