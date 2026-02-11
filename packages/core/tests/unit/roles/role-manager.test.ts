import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { renderPrompt } from '../../../src/roles/prompts.js';
import type { PromptType } from '../../../src/roles/prompts.js';
import { RoleManager } from '../../../src/roles/role-manager.js';
import type { ProjectConfig } from '../../../src/types/config.js';

const testConfig: ProjectConfig = {
  ...DEFAULT_CONFIG,
  project: {
    name: 'TestProject',
    description: 'A test project for unit tests',
  },
};

describe('RoleManager', () => {
  it('getRole returns built-in architect role', () => {
    const rm = new RoleManager(testConfig);
    const role = rm.getRole('architect');

    expect(role.id).toBe('architect');
    expect(role.modelAlias).toBe('codex-architect');
    expect(role.temperature).toBe(0.7);
    expect(role.maxTokens).toBe(4096);
    expect(role.description).toContain('Plans');
    expect(role.systemPrompt).toContain('architect');
  });

  it('getRole returns built-in reviewer role', () => {
    const rm = new RoleManager(testConfig);
    const role = rm.getRole('reviewer');

    expect(role.id).toBe('reviewer');
    expect(role.modelAlias).toBe('codex-reviewer');
    expect(role.temperature).toBe(0.3);
    expect(role.description).toContain('Reviews');
  });

  it('getRole returns built-in implementer role', () => {
    const rm = new RoleManager(testConfig);
    const role = rm.getRole('implementer');

    expect(role.id).toBe('implementer');
    expect(role.modelAlias).toBe('codex-architect');
    expect(role.temperature).toBe(0.4);
    expect(role.maxTokens).toBe(8192);
  });

  it('getRole throws for unknown role', () => {
    const rm = new RoleManager(testConfig);
    expect(() => rm.getRole('nonexistent')).toThrow('Unknown role');
  });

  it('getRole uses config overrides for temperature and maxTokens', () => {
    const config: ProjectConfig = {
      ...testConfig,
      roles: {
        ...testConfig.roles,
        architect: {
          model: 'codex-architect',
          temperature: 0.2,
          maxTokens: 2048,
        },
      },
    };
    const rm = new RoleManager(config);
    const role = rm.getRole('architect');

    expect(role.temperature).toBe(0.2);
    expect(role.maxTokens).toBe(2048);
  });

  it('listRoles returns all configured role names', () => {
    const rm = new RoleManager(testConfig);
    const roles = rm.listRoles();

    expect(roles).toContain('architect');
    expect(roles).toContain('reviewer');
    expect(roles).toContain('implementer');
    expect(roles).toHaveLength(3);
  });

  it('getRoleConfig returns raw config for a role', () => {
    const rm = new RoleManager(testConfig);
    const config = rm.getRoleConfig('architect');

    expect(config.model).toBe('codex-architect');
  });

  it('getRoleConfig throws for unknown role', () => {
    const rm = new RoleManager(testConfig);
    expect(() => rm.getRoleConfig('nonexistent')).toThrow('Unknown role');
  });
});

describe('buildMessages', () => {
  it('builds plan messages with project context', () => {
    const rm = new RoleManager(testConfig);
    const messages = rm.buildMessages('plan', { task: 'Add user authentication' });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('senior software architect');
    expect(messages[0].content).toContain('TestProject');
    expect(messages[0].content).toContain('implementation plan');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('Add user authentication');
  });

  it('builds plan-review messages with plan content', () => {
    const rm = new RoleManager(testConfig);
    const messages = rm.buildMessages('plan-review', {
      task: 'Add auth',
      plan: 'Step 1: Install passport.js\nStep 2: Configure routes',
    });

    expect(messages[0].content).toContain('senior technical reviewer');
    expect(messages[0].content).toContain('VERDICT');
    expect(messages[1].content).toContain('Add auth');
    expect(messages[1].content).toContain('passport.js');
  });

  it('builds plan-revision messages with feedback', () => {
    const rm = new RoleManager(testConfig);
    const messages = rm.buildMessages('plan-revision', {
      task: 'Add auth',
      previousPlan: 'Original plan...',
      feedback: 'Missing error handling',
    });

    expect(messages[0].content).toContain('needs revision');
    expect(messages[1].content).toContain('Original plan...');
    expect(messages[1].content).toContain('Missing error handling');
  });

  it('builds code messages with plan', () => {
    const rm = new RoleManager(testConfig);
    const messages = rm.buildMessages('code', {
      task: 'Add auth',
      plan: 'Approved plan details...',
    });

    expect(messages[0].content).toContain('senior software developer');
    expect(messages[0].content).toContain('complete file contents');
    expect(messages[1].content).toContain('Approved plan details...');
  });

  it('builds code-review messages with code', () => {
    const rm = new RoleManager(testConfig);
    const messages = rm.buildMessages('code-review', {
      task: 'Add auth',
      plan: 'The plan',
      code: 'function login() { return true; }',
    });

    expect(messages[0].content).toContain('senior code reviewer');
    expect(messages[0].content).toContain('VERDICT');
    expect(messages[1].content).toContain('function login');
  });

  it('uses empty string for missing project context', () => {
    const rm = new RoleManager(DEFAULT_CONFIG);
    const messages = rm.buildMessages('plan', { task: 'Do something' });

    // Default config has empty project name/description
    expect(messages[0].content).toContain('senior software architect');
    expect(messages[1].content).toContain('Do something');
  });

  it('allows overriding project context in vars', () => {
    const rm = new RoleManager(testConfig);
    const messages = rm.buildMessages('plan', {
      task: 'Task',
      projectName: 'OverrideName',
      projectDescription: 'Override description',
    });

    expect(messages[0].content).toContain('OverrideName');
    expect(messages[0].content).toContain('Override description');
  });
});

describe('renderPrompt', () => {
  const promptTypes: PromptType[] = ['plan', 'plan-review', 'plan-revision', 'code', 'code-review'];

  it('renders all prompt types without error', () => {
    for (const type of promptTypes) {
      const messages = renderPrompt(type, {
        task: 'Test task',
        plan: 'Test plan',
        previousPlan: 'Previous plan',
        feedback: 'Some feedback',
        code: 'console.log("hello")',
        projectName: 'Proj',
        projectDescription: 'Desc',
      });

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('system');
      expect(messages[1].role).toBe('user');
    }
  });

  it('plan prompt includes required sections', () => {
    const messages = renderPrompt('plan', { task: 'Build API' });

    expect(messages[0].content).toContain('Overview');
    expect(messages[0].content).toContain('Technical Approach');
    expect(messages[0].content).toContain('File Changes');
    expect(messages[0].content).toContain('Implementation Details');
    expect(messages[0].content).toContain('Testing Strategy');
    expect(messages[0].content).toContain('Edge Cases');
  });

  it('review prompts include VERDICT instruction', () => {
    const planReview = renderPrompt('plan-review', { task: 'x', plan: 'y' });
    const codeReview = renderPrompt('code-review', { task: 'x', plan: 'y', code: 'z' });

    expect(planReview[0].content).toContain('VERDICT: APPROVED');
    expect(planReview[0].content).toContain('VERDICT: NEEDS_REVISION');
    expect(codeReview[0].content).toContain('VERDICT: APPROVED');
    expect(codeReview[0].content).toContain('VERDICT: NEEDS_REVISION');
  });
});
