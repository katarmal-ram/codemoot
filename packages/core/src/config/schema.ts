// packages/core/src/config/schema.ts

import { z } from 'zod';
import { CONTEXT_ACTIVE, CONTEXT_BUFFER, CONTEXT_RETRIEVED, DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_SEC } from '../utils/constants.js';
import { ConfigError } from '../utils/errors.js';

const modelProviderSchema = z.literal('openai');

const cliAdapterConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  timeout: z.number().positive(),
  outputFile: z.string().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  envAllowlist: z.array(z.string()).optional(),
});

const modelConfigSchema = z.object({
  provider: modelProviderSchema,
  model: z.string().min(1),
  maxTokens: z.number().int().positive().default(DEFAULT_MAX_TOKENS),
  temperature: z.number().min(0).max(2).default(0.7),
  timeout: z.number().positive().default(DEFAULT_TIMEOUT_SEC),
  cliAdapter: cliAdapterConfigSchema.optional(),
});

const roleConfigSchema = z.object({
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  systemPromptFile: z.string().optional(),
});

const debatePatternSchema = z.enum([
  'structured-rounds',
  'proposal-critique',
  'free-flowing',
  'parallel-panel',
]);

const debateConfigSchema = z.object({
  defaultPattern: debatePatternSchema.default('proposal-critique'),
  maxRounds: z.number().int().positive().max(10).default(3),
  consensusThreshold: z.number().min(0).max(1).default(0.7),
});

const memoryConfigSchema = z.object({
  embeddingModel: z.string().optional(),
  autoExtractFacts: z.boolean().default(true),
  contextBudget: z
    .object({
      activeContext: z.number().int().positive().default(CONTEXT_ACTIVE),
      retrievedMemory: z.number().int().positive().default(CONTEXT_RETRIEVED),
      messageBuffer: z.number().int().positive().default(CONTEXT_BUFFER),
    })
    .default({}),
});

const budgetConfigSchema = z.object({
  perSession: z.number().nonnegative().default(5.0),
  perDay: z.number().nonnegative().default(25.0),
  perMonth: z.number().nonnegative().default(200.0),
  warningAt: z.number().min(0).max(1).default(0.8),
  action: z.enum(['warn', 'pause', 'block']).default('warn'),
});

const outputConfigSchema = z.object({
  saveTranscripts: z.boolean().default(true),
  transcriptFormat: z.enum(['markdown', 'json']).default('markdown'),
  transcriptDir: z.string().default('.cowork/transcripts'),
});

const executionModeSchema = z.enum(['autonomous', 'interactive', 'dashboard']);

const advancedConfigSchema = z.object({
  retryAttempts: z.number().int().positive().max(10).default(3),
  stream: z.boolean().default(true),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export const projectConfigSchema = z
  .object({
    configVersion: z.number().int().positive().optional(),
    project: z
      .object({
        name: z.string().default(''),
        description: z.string().default(''),
      })
      .default({}),
    models: z.record(z.string(), modelConfigSchema),
    roles: z.record(z.string(), roleConfigSchema),
    workflow: z.string().default('plan-review-implement'),
    mode: executionModeSchema.default('autonomous'),
    debate: debateConfigSchema.default({}),
    memory: memoryConfigSchema.default({}),
    budget: budgetConfigSchema.default({}),
    output: outputConfigSchema.default({}),
    advanced: advancedConfigSchema.default({}),
  })
  .superRefine((data, ctx) => {
    const modelAliases = Object.keys(data.models);
    for (const [roleName, roleConfig] of Object.entries(data.roles)) {
      if (!modelAliases.includes(roleConfig.model)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['roles', roleName, 'model'],
          message: `Role "${roleName}" references model "${roleConfig.model}" which is not defined in models. Available: ${modelAliases.join(', ')}`,
        });
      }
    }
  });

export type ProjectConfigInput = z.input<typeof projectConfigSchema>;

/**
 * Validate and parse a config object. Throws ConfigError on invalid input.
 */
export function validateConfig(config: unknown): z.output<typeof projectConfigSchema> {
  const result = projectConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  return result.data;
}
