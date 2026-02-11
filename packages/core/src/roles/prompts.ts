// packages/core/src/roles/prompts.ts

import type { ChatMessage } from '../types/models.js';

/**
 * The 5 prompt types supported in Sprint 1.
 */
export type PromptType = 'plan' | 'plan-review' | 'plan-revision' | 'code' | 'code-review';

/**
 * Variables passed into prompt templates.
 */
export interface PromptVariables {
  task: string;
  projectName?: string;
  projectDescription?: string;
  plan?: string;
  previousPlan?: string;
  feedback?: string;
  code?: string;
}

/**
 * Render a prompt template into ChatMessage[] (system + user messages).
 */
export function renderPrompt(type: PromptType, vars: PromptVariables): ChatMessage[] {
  const template = TEMPLATES[type];
  const projectCtx = formatProjectContext(vars.projectName, vars.projectDescription);

  return [
    { role: 'system', content: template.system(projectCtx) },
    { role: 'user', content: template.user(vars) },
  ];
}

// -- Template definitions --

interface PromptTemplate {
  system: (projectCtx: string) => string;
  user: (vars: PromptVariables) => string;
}

function formatProjectContext(name?: string, description?: string): string {
  if (name && description) return `working on "${name}": ${description}`;
  if (name) return `working on "${name}"`;
  return '';
}

const TEMPLATES: Record<PromptType, PromptTemplate> = {
  /**
   * Architect -- Plan Generation
   */
  plan: {
    system: (ctx) =>
      [
        `You are a senior software architect ${ctx}.`.trim(),
        '',
        'Given the following task, create a detailed implementation plan.',
        '',
        '## Your plan MUST include these sections:',
        '',
        '### 1. Overview',
        'What this task accomplishes and why.',
        '',
        '### 2. Technical Approach',
        'High-level strategy, key design decisions, and tradeoffs.',
        '',
        '### 3. File Changes',
        'For each file to create or modify:',
        '- **File path**',
        '- **Action**: create | modify',
        '- **Description of changes**',
        '',
        '### 4. Implementation Details',
        'Step-by-step implementation instructions. Include pseudocode for complex logic.',
        '',
        '### 5. Testing Strategy',
        'How to verify the implementation works. Specific test cases.',
        '',
        '### 6. Edge Cases & Risks',
        'Potential issues and how to handle them.',
      ].join('\n'),
    user: (vars) => `## Task:\n${vars.task}`,
  },

  /**
   * Reviewer -- Plan Review
   */
  'plan-review': {
    system: (ctx) =>
      [
        `You are a senior technical reviewer ${ctx}.`.trim(),
        '',
        'Review the following plan for:',
        '- **Correctness**: Is the approach technically sound?',
        '- **Completeness**: Does it address all aspects of the task?',
        '- **Quality**: Is the plan well-structured and actionable?',
        '- **Risks**: Are there overlooked edge cases or potential issues?',
        '',
        'Provide specific, actionable feedback. Reference plan sections by name.',
        '',
        'At the END of your review, you MUST include exactly one of these lines:',
        'VERDICT: APPROVED',
        'VERDICT: NEEDS_REVISION',
      ].join('\n'),
    user: (vars) => `## Task:\n${vars.task}\n\n## Plan to Review:\n${vars.plan ?? ''}`,
  },

  /**
   * Architect -- Plan Revision
   */
  'plan-revision': {
    system: (ctx) =>
      [
        `You are a senior software architect ${ctx}.`.trim(),
        '',
        "Your previous plan was reviewed and needs revision. Address the reviewer's feedback while keeping the strengths of your original plan.",
        '',
        'Produce a revised plan with the same section structure (Overview, Technical Approach, File Changes, Implementation Details, Testing Strategy, Edge Cases & Risks).',
      ].join('\n'),
    user: (vars) =>
      [
        `## Original Task:\n${vars.task}`,
        `## Your Previous Plan:\n${vars.previousPlan ?? ''}`,
        `## Reviewer Feedback:\n${vars.feedback ?? ''}`,
      ].join('\n\n'),
  },

  /**
   * Implementer -- Code Generation
   */
  code: {
    system: (ctx) =>
      [
        `You are a senior software developer ${ctx}.`.trim(),
        '',
        'Based on the following approved plan, write the complete implementation.',
        '',
        '## Rules:',
        '- Write complete file contents, not snippets',
        '- Include all imports and type definitions',
        "- Follow the project's existing patterns",
        '- Add comments only where logic is non-obvious',
        '- For each file, use this format:',
        '',
        '### File: path/to/file.ts',
        '```ts',
        '// complete file contents here',
        '```',
      ].join('\n'),
    user: (vars) => `## Approved Plan:\n${vars.plan ?? ''}`,
  },

  /**
   * Reviewer -- Code Review
   */
  'code-review': {
    system: (ctx) =>
      [
        `You are a senior code reviewer ${ctx}.`.trim(),
        '',
        'Review the following implementation for:',
        '- **Correctness**: Does it implement the plan correctly?',
        '- **Bugs**: Logic errors, off-by-one, race conditions?',
        '- **Security**: OWASP Top 10 issues?',
        '- **Performance**: Obvious performance problems?',
        '- **Quality**: Clean code, error handling, naming?',
        '',
        'Provide specific feedback with file names and references.',
        '',
        'At the END of your review, you MUST include exactly one of:',
        'VERDICT: APPROVED',
        'VERDICT: NEEDS_REVISION',
      ].join('\n'),
    user: (vars) =>
      [
        `## Task:\n${vars.task}`,
        `## Approved Plan:\n${vars.plan ?? ''}`,
        `## Implementation to Review:\n${vars.code ?? ''}`,
      ].join('\n\n'),
  },
};
