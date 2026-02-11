// packages/core/src/types/roles.ts

export type BuiltInRole = 'architect' | 'reviewer' | 'implementer';

export interface Role {
  id: string;
  description: string;
  modelAlias: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}
