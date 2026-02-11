// packages/core/src/roles/role-manager.ts

import type { ProjectConfig, RoleConfig } from '../types/config.js';
import type { ChatMessage } from '../types/models.js';
import type { BuiltInRole, Role } from '../types/roles.js';
import { DEFAULT_MAX_TOKENS } from '../utils/constants.js';
import { ModelError } from '../utils/errors.js';
import type { PromptType, PromptVariables } from './prompts.js';
import { renderPrompt } from './prompts.js';

/**
 * Built-in role definitions with default descriptions.
 */
const BUILT_IN_ROLES: Record<BuiltInRole, { description: string }> = {
  architect: { description: 'Plans implementation strategy and technical approach' },
  reviewer: { description: 'Reviews plans and code for correctness, quality, and risks' },
  implementer: { description: 'Writes production code based on approved plans' },
};

/**
 * Resolves roles from config, provides prompt rendering and message assembly.
 */
export class RoleManager {
  constructor(private config: ProjectConfig) {}

  /**
   * Resolve a role name to a fully hydrated Role object.
   * Merges built-in defaults with config overrides.
   */
  getRole(roleName: string): Role {
    const roleConfig = this.config.roles[roleName];
    if (!roleConfig) {
      throw new ModelError(
        `Unknown role: "${roleName}". Available: ${Object.keys(this.config.roles).join(', ')}`,
      );
    }

    const builtIn = BUILT_IN_ROLES[roleName as BuiltInRole];
    const modelConfig = this.config.models[roleConfig.model];

    return {
      id: roleName,
      description: builtIn?.description ?? `Custom role: ${roleName}`,
      modelAlias: roleConfig.model,
      systemPrompt: buildRoleIdentity(roleName, builtIn?.description),
      temperature: roleConfig.temperature ?? modelConfig?.temperature ?? 0.7,
      maxTokens: roleConfig.maxTokens ?? modelConfig?.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  }

  /**
   * Build a ChatMessage[] for a model call.
   * Renders the appropriate prompt template with project context and variables.
   */
  buildMessages(promptType: PromptType, vars: PromptVariables): ChatMessage[] {
    return renderPrompt(promptType, {
      ...vars,
      projectName: vars.projectName ?? this.config.project.name,
      projectDescription: vars.projectDescription ?? this.config.project.description,
    });
  }

  /** List all configured role names. */
  listRoles(): string[] {
    return Object.keys(this.config.roles);
  }

  /** Get the RoleConfig for a role name. */
  getRoleConfig(roleName: string): RoleConfig {
    const roleConfig = this.config.roles[roleName];
    if (!roleConfig) {
      throw new ModelError(`Unknown role: "${roleName}"`);
    }
    return roleConfig;
  }
}

function buildRoleIdentity(roleName: string, description?: string): string {
  if (description) {
    return `You are a ${roleName}. ${description}.`;
  }
  return `You are a ${roleName}.`;
}
