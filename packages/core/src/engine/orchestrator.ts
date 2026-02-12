// packages/core/src/engine/orchestrator.ts

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { EventEmitter } from 'eventemitter3';
import { ContextBuilder } from '../context/context-builder.js';
import { ArtifactStore } from '../memory/artifact-store.js';
import { CostStore } from '../memory/cost-store.js';
import { MemoryStore } from '../memory/memory-store.js';
import { SessionStore } from '../memory/session-store.js';
import { callModel } from '../models/caller.js';
import { CliAdapter } from '../models/cli-adapter.js';
import { CostTracker } from '../models/cost-tracker.js';
import type { ModelRegistry } from '../models/registry.js';
import { RoleManager } from '../roles/role-manager.js';
import { sanitize } from '../security/dlp.js';
import type { ExecutionMode, ProjectConfig } from '../types/config.js';
import type { DebateEngineInput, DebateEngineResult, DebateIO } from '../types/debate.js';
import type { EngineEvent } from '../types/events.js';
import type { DebateResponse, DebateResult, MeteringSource, ReviewResult } from '../types/mcp.js';
import { parseVerdict } from '../utils/verdict.js';
import type { CancellationToken } from './cancellation.js';
import { ProposalCritiqueEngine } from './debate-engine.js';
import { EventBus } from './event-bus.js';
import { LoopController } from './loop-controller.js';
import { StepRunner } from './step-runner.js';
import { WorkflowEngine } from './workflow-engine.js';

const currentDir = dirname(fileURLToPath(import.meta.url));

interface OrchestratorEvents {
  event: (event: EngineEvent) => void;
}

export interface OrchestratorOptions {
  registry: ModelRegistry;
  db: Database.Database;
  config: ProjectConfig;
  workflowDir?: string;
  projectDir?: string;
}

export interface RunOptions {
  mode?: ExecutionMode;
  maxIterations?: number;
  stream?: boolean;
  workflowDir?: string;
}

export interface PlanOptions {
  maxRounds?: number;
  stream?: boolean;
  workflowDir?: string;
  /** Score threshold (1-10) for auto-approving plans on 2nd+ iteration. Default: 8. */
  autoApproveThreshold?: number;
}

export interface SessionResult {
  sessionId: string;
  status: 'completed' | 'failed';
  finalOutput: string;
  totalCost: number;
  totalTokens: number;
  durationMs: number;
  iterations: number;
  error?: string;
  lastStep?: string;
}

export interface ReviewOptions {
  criteria?: string[];
  model?: string;
  strict?: boolean;
  timeout?: number;
}

export interface DebateOptions {
  modelAliases?: string[];
  synthesize?: boolean;
  timeout?: number;
  maxConcurrency?: number;
}

type SessionPhase = 'plan-review' | 'implement' | 'code-review';

const DEFAULT_MAX_CLI_CONCURRENCY = 3;
const DEFAULT_MAX_API_CONCURRENCY = 5;

/** Promise-based semaphore — replaces busy-wait polling. */
class AsyncSemaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private registry: ModelRegistry;
  private config: ProjectConfig;
  private sessionStore: SessionStore;
  private artifactStore: ArtifactStore;
  private costStore: CostStore;
  private memoryStore: MemoryStore;
  private roleManager: RoleManager;
  private workflowEngine: WorkflowEngine;
  private eventBus: EventBus;
  private contextBuilder: ContextBuilder;

  constructor(options: OrchestratorOptions) {
    super();
    this.registry = options.registry;
    this.config = options.config;
    this.sessionStore = new SessionStore(options.db);
    this.artifactStore = new ArtifactStore(options.db);
    this.costStore = new CostStore(options.db);
    this.memoryStore = new MemoryStore(options.db);
    this.roleManager = new RoleManager(options.config);

    const resolvedDir =
      options.workflowDir ??
      (options.projectDir
        ? resolve(options.projectDir, 'workflows')
        : resolve(currentDir, '../../../workflows'));
    this.workflowEngine = new WorkflowEngine(resolvedDir);
    this.eventBus = new EventBus();

    // Context builder for enriching prompts with memories + codebase context
    this.contextBuilder = new ContextBuilder({
      projectDir: options.projectDir,
      projectId: options.config.project.name || 'default',
      memoryStore: this.memoryStore,
    });

    // Forward all events from eventBus to this orchestrator
    this.eventBus.on('event', (event) => this.emit('event', event));
  }

  async run(task: string, options?: RunOptions): Promise<SessionResult> {
    return this.executeSession(task, ['plan-review', 'implement', 'code-review'], {
      maxIterations: options?.maxIterations,
      stream: options?.stream,
      mode: options?.mode,
    });
  }

  async plan(task: string, options?: PlanOptions): Promise<SessionResult> {
    return this.executeSession(task, ['plan-review'], {
      maxIterations: options?.maxRounds,
      stream: options?.stream,
      planAutoApproveThreshold: options?.autoApproveThreshold ?? 8,
    });
  }

  /**
   * Review content with a single model.
   * DLP-sanitizes content first (strict mode by default).
   */
  async review(
    content: string,
    options?: ReviewOptions,
    cancellationToken?: CancellationToken,
  ): Promise<ReviewResult> {
    const start = Date.now();

    // DLP sanitize
    const dlpMode = options?.strict !== false ? 'strict' : 'open';
    const dlpResult = sanitize(content, { mode: dlpMode });
    const sanitizedContent = dlpResult.sanitized;

    // Check cancellation
    if (cancellationToken?.isCancelled) {
      throw new Error('Review cancelled');
    }

    // Resolve model
    const alias = options?.model ?? this.resolveReviewerAlias();
    const adapter = this.registry.getAdapter(alias);
    const isCli = adapter instanceof CliAdapter;
    const meteringSource: MeteringSource = isCli ? 'estimated' : 'billed';

    // Build review prompt
    const criteriaText = options?.criteria?.length
      ? `Review criteria:\n${options.criteria.map((c) => `- ${c}`).join('\n')}`
      : '';
    const basePrompt = [
      'Review the following content carefully.',
      criteriaText,
      'Provide a score from 1-10, specific feedback points, and a final VERDICT.',
      'Format your verdict as either "VERDICT: APPROVED" or "VERDICT: NEEDS_REVISION".',
      '',
      'Content to review:',
      sanitizedContent,
    ]
      .filter(Boolean)
      .join('\n');

    // Enrich with project context and memories
    const assembled = this.contextBuilder.assemble(basePrompt, 'review');
    const messages = [{ role: 'user' as const, content: assembled.prompt }];

    // Call model
    const result = await callModel(adapter, messages);

    // Parse verdict — wrap in try/catch so LLM output variance doesn't crash
    let verdict: { verdict: 'approved' | 'needs_revision'; feedback: string };
    try {
      verdict = parseVerdict(result.text);
    } catch {
      verdict = { verdict: 'needs_revision', feedback: result.text.slice(0, 500) };
    }

    // Score extraction: try multiple patterns (X/10, X out of 10, score: X, Score: X.X)
    const scorePatterns = [
      /\b(\d+)\s*\/\s*10\b/,
      /\b(\d+)\s+out\s+of\s+10\b/i,
      /score[:\s]+(\d+(?:\.\d+)?)/i,
    ];
    let score: number | undefined;
    for (const pattern of scorePatterns) {
      const match = pattern.exec(result.text);
      if (match) {
        score = Math.round(Number.parseFloat(match[1]));
        break;
      }
    }
    if (score === undefined) {
      score = verdict.verdict === 'approved' ? 8 : 5;
    }

    const feedback = result.text
      .split('\n')
      .filter((line) => line.trim().startsWith('-') || line.trim().startsWith('*'))
      .map((line) => line.trim().replace(/^[-*]\s*/, ''));

    // Auto-save review findings as memory (with dedup)
    if (feedback.length > 0 && score <= 7) {
      const projectId = this.config.project.name || 'default';
      const memorySummary = `Review (${score}/10, ${verdict.verdict}): ${feedback.slice(0, 3).join('; ')}`;
      this.saveMemoryIfNew(projectId, 'issue', memorySummary, score <= 5 ? 0.8 : 0.5);
    }

    return {
      status: 'success',
      score,
      verdict: verdict.verdict,
      feedback: feedback.length > 0 ? feedback : [verdict.feedback || result.text.slice(0, 200)],
      tokenUsage: result.usage,
      latencyMs: Date.now() - start,
      meteringSource,
      model: result.model,
      egressControl: isCli ? 'cli-managed' : 'codemoot-enforced',
    };
  }

  /**
   * Debate a question across multiple models.
   * DLP-sanitizes question first. Runs models concurrently with async semaphore.
   */
  async debate(
    question: string,
    options?: DebateOptions,
    cancellationToken?: CancellationToken,
  ): Promise<DebateResult> {
    // DLP sanitize
    const dlpResult = sanitize(question, { mode: 'strict' });
    const sanitizedQuestion = dlpResult.sanitized;

    // Check cancellation
    if (cancellationToken?.isCancelled) {
      throw new Error('Debate cancelled');
    }

    // Resolve model aliases
    const aliases = options?.modelAliases ?? this.resolveDebateAliases();
    if (aliases.length < 1) {
      throw new Error(
        `Debate requires at least 1 model. Available: ${this.registry.listAliases().join(', ')}`,
      );
    }

    // Enrich question with project context and memories
    const assembled = this.contextBuilder.assemble(sanitizedQuestion, 'debate');
    const enrichedQuestion = assembled.prompt;

    const maxCliConcurrency =
      options?.maxConcurrency ??
      Number(process.env.CODEMOOT_MAX_CLI_CONCURRENCY ?? DEFAULT_MAX_CLI_CONCURRENCY);
    const maxApiConcurrency = DEFAULT_MAX_API_CONCURRENCY;

    // Async semaphores for concurrency control
    const cliSemaphore = new AsyncSemaphore(maxCliConcurrency);
    const apiSemaphore = new AsyncSemaphore(maxApiConcurrency);

    const callWithSemaphore = async (alias: string): Promise<DebateResponse> => {
      const adapter = this.registry.getAdapter(alias);
      const isCli = adapter instanceof CliAdapter;
      const meteringSource: MeteringSource = isCli ? 'estimated' : 'billed';
      const config = this.registry.getModelConfig(alias);
      const semaphore = isCli ? cliSemaphore : apiSemaphore;

      await semaphore.acquire();
      const callStart = Date.now();
      try {
        if (cancellationToken?.isCancelled) {
          throw new Error('Debate cancelled');
        }

        const messages = [{ role: 'user' as const, content: enrichedQuestion }];
        const result = await callModel(adapter, messages);

        return {
          model: config.model,
          role: alias,
          text: result.text,
          tokenUsage: result.usage,
          latencyMs: Date.now() - callStart,
          meteringSource,
        };
      } catch (err) {
        return {
          model: config.model,
          role: alias,
          text: '',
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          latencyMs: Date.now() - callStart,
          meteringSource,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        semaphore.release();
      }
    };

    // Run all models concurrently
    const results = await Promise.allSettled(aliases.map(callWithSemaphore));
    const responses: DebateResponse[] = results.map((r) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            model: 'unknown',
            role: 'unknown',
            text: '',
            tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
            latencyMs: 0,
            meteringSource: 'estimated' as MeteringSource,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
    );

    const successfulResponses = responses.filter((r) => !r.error);
    const partialFailure = successfulResponses.length < responses.length;

    if (successfulResponses.length === 0) {
      const errors = responses.map((r) => `${r.role}: ${r.error}`).join('; ');
      throw new Error(`All models failed in debate: ${errors}`);
    }

    // Aggregate token usage
    const totalTokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    };
    for (const r of responses) {
      totalTokenUsage.inputTokens += r.tokenUsage.inputTokens;
      totalTokenUsage.outputTokens += r.tokenUsage.outputTokens;
      totalTokenUsage.totalTokens += r.tokenUsage.totalTokens;
      totalTokenUsage.costUsd += r.tokenUsage.costUsd;
    }

    // Optional synthesis
    let synthesis: string | undefined;
    if (options?.synthesize && successfulResponses.length > 1) {
      const synthPrompt = [
        'Synthesize the following responses into a unified answer:',
        '',
        ...successfulResponses.map((r, i) => `Response ${i + 1} (${r.model}):\n${r.text}`),
      ].join('\n\n');

      // Use first available model for synthesis
      const synthAdapter = this.registry.getAdapter(aliases[0]);
      const synthResult = await callModel(synthAdapter, [{ role: 'user', content: synthPrompt }]);
      synthesis = synthResult.text;

      totalTokenUsage.inputTokens += synthResult.usage.inputTokens;
      totalTokenUsage.outputTokens += synthResult.usage.outputTokens;
      totalTokenUsage.totalTokens += synthResult.usage.totalTokens;
      totalTokenUsage.costUsd += synthResult.usage.costUsd;
    }

    // Determine egress control — if any model uses CLI, report mixed
    const hasCliModel = aliases.some((a) => this.registry.isCliMode(a));
    const egressControl = hasCliModel ? 'cli-managed' : 'codemoot-enforced';

    return {
      status: partialFailure ? 'partial' : 'success',
      responses,
      synthesis,
      totalTokenUsage,
      partialFailure,
      egressControl,
    };
  }

  /**
   * Multi-round debate: models see and respond to each other's arguments.
   * Uses proposal-critique pattern: proposer → critic → revise → critique → ...
   * Models iterate until convergence (critic approves) or max rounds.
   */
  async debateMultiRound(
    question: string,
    options?: {
      modelAliases?: string[];
      maxRounds?: number;
      timeout?: number;
    },
  ): Promise<DebateEngineResult> {
    // DLP sanitize
    const dlpResult = sanitize(question, { mode: 'strict' });
    const sanitizedQuestion = dlpResult.sanitized;

    // Enrich with project context
    const assembled = this.contextBuilder.assemble(sanitizedQuestion, 'debate');
    const enrichedQuestion = assembled.prompt;

    // Resolve aliases: need at least 2 for proposal-critique
    const aliases = options?.modelAliases ?? this.resolveDebateAliases();
    if (aliases.length < 2) {
      throw new Error(
        `Multi-round debate requires at least 2 models. Available: ${this.registry.listAliases().join(', ')}`,
      );
    }

    // Build DebateIO adapter that wraps our callModel + registry
    const io: DebateIO = {
      generate: async (modelAlias, messages, timeoutMs) => {
        const adapter = this.registry.getAdapter(modelAlias);
        const chatMessages = messages.map((m) => ({
          role: m.role as 'system' | 'user',
          content: m.content,
        }));
        const result = await callModel(adapter, chatMessages, {
          timeout: Math.ceil(timeoutMs / 1000),
        });
        return {
          text: result.text,
          promptTokens: result.usage.inputTokens,
          completionTokens: result.usage.outputTokens,
        };
      },
    };

    // Create and run the debate engine
    const engine = new ProposalCritiqueEngine({
      maxRounds: options?.maxRounds ?? this.config.debate.maxRounds,
      maxWallClockMs: (options?.timeout ?? 600) * 1000,
    });

    const input: DebateEngineInput = {
      debateId: `debate_${Date.now()}`,
      question: enrichedQuestion,
      models: aliases.slice(0, 2), // proposal-critique uses exactly 2
    };

    return engine.run(input, io);
  }

  /** Resolve the default reviewer model alias from roles config. */
  private resolveReviewerAlias(): string {
    const reviewerRole = this.config.roles.reviewer;
    if (reviewerRole) return reviewerRole.model;
    // Fallback to first available alias
    const aliases = this.registry.listAliases();
    if (aliases.length === 0) {
      throw new Error('No models configured for review');
    }
    return aliases[0];
  }

  /** Resolve debate aliases — all configured model aliases. */
  private resolveDebateAliases(): string[] {
    return this.registry.listAliases();
  }

  /**
   * Save a memory only if no similar entry already exists (content-prefix dedup).
   * Uses SQL LIKE prefix match instead of FTS5 for reliable exact matching.
   */
  private saveMemoryIfNew(
    projectId: string,
    category: 'issue' | 'convention' | 'decision' | 'pattern' | 'preference',
    content: string,
    importance: number,
  ): void {
    const prefix = content.slice(0, 80);
    const existing = this.memoryStore.findByPrefix(projectId, category, prefix);
    if (!existing) {
      this.memoryStore.save({
        projectId,
        category,
        content,
        sourceSessionId: null,
        importance,
      });
    }
  }

  /**
   * Shared session lifecycle for run() and plan().
   * Extracts common session creation, workflow loading, cost tracking, and completion.
   */
  private async executeSession(
    task: string,
    phases: SessionPhase[],
    options: { maxIterations?: number; stream?: boolean; mode?: ExecutionMode; planAutoApproveThreshold?: number },
  ): Promise<SessionResult> {
    const startTime = Date.now();
    const maxIterations = options.maxIterations ?? this.config.debate.maxRounds ?? 3;
    const stream = options.stream ?? this.config.advanced.stream;

    // 1. Create session
    const session = this.sessionStore.create({
      projectId: this.config.project.name || 'default',
      workflowId: 'plan-review-implement',
      task,
      mode: options.mode ?? this.config.mode,
      config: this.config,
    });

    // 2. Emit session.started
    this.eventBus.emitEvent({
      type: 'session.started',
      sessionId: session.id,
      workflow: 'plan-review-implement',
      task,
      timestamp: new Date().toISOString(),
    });

    let currentStep = 'init';

    try {
      // 3. Load workflow
      const workflow = this.workflowEngine.load('plan-review-implement');
      const steps = this.workflowEngine.getExecutionOrder(workflow);

      // 4. Create step runner and cost tracker
      const costTracker = new CostTracker(this.costStore, session.id);
      const stepRunner = new StepRunner(
        this.registry,
        this.roleManager,
        costTracker,
        this.eventBus,
        this.sessionStore,
        this.config,
        session.id,
      );
      const loopController = new LoopController();

      // 5. Execute requested phases
      let totalIterations = 0;
      let finalOutput = '';
      const inputs = new Map<string, string>();

      const planStep = steps.find((s) => s.definition.id === 'plan');
      const reviewPlanStep = steps.find((s) => s.definition.id === 'review-plan');
      const implementStep = steps.find((s) => s.definition.id === 'implement');
      const codeReviewStep = steps.find((s) => s.definition.id === 'code-review');

      // Phase: Plan + Review Loop
      if (phases.includes('plan-review') && planStep && reviewPlanStep) {
        currentStep = 'plan';
        this.sessionStore.updateCurrentStep(session.id, 'plan');
        const planLoop = await loopController.executeLoop(
          planStep,
          reviewPlanStep,
          inputs,
          task,
          maxIterations,
          stepRunner,
          this.eventBus,
          { autoApproveThreshold: options.planAutoApproveThreshold },
        );
        inputs.set('plan.output', planLoop.finalOutput);
        totalIterations += planLoop.iterations;
        finalOutput = planLoop.finalOutput;

        this.artifactStore.save({
          sessionId: session.id,
          stepId: 'plan',
          iteration: planLoop.iterations,
          type: 'plan',
          filePath: null,
          content: planLoop.finalOutput,
          version: 1,
          metadata: null,
        });
      }

      // Phase: Implement
      if (phases.includes('implement') && implementStep) {
        currentStep = 'implement';
        this.sessionStore.updateCurrentStep(session.id, 'implement');
        const implResult = await stepRunner.execute(implementStep, inputs, task, 1, { stream });
        inputs.set('implement.output', implResult.output);
        finalOutput = implResult.output;

        this.artifactStore.save({
          sessionId: session.id,
          stepId: 'implement',
          iteration: 1,
          type: 'code',
          filePath: null,
          content: implResult.output,
          version: 1,
          metadata: null,
        });
      }

      // Phase: Code Review Loop
      if (phases.includes('code-review') && implementStep && codeReviewStep) {
        currentStep = 'code-review';
        this.sessionStore.updateCurrentStep(session.id, 'code-review');
        const codeLoop = await loopController.executeLoop(
          implementStep,
          codeReviewStep,
          inputs,
          task,
          maxIterations,
          stepRunner,
          this.eventBus,
        );
        totalIterations += codeLoop.iterations;
        finalOutput = codeLoop.finalOutput;

        this.artifactStore.save({
          sessionId: session.id,
          stepId: 'code-review',
          iteration: codeLoop.iterations,
          type: 'review',
          filePath: null,
          content: codeLoop.finalOutput,
          version: 1,
          metadata: null,
        });
      }

      // 6. Complete session
      const costSummary = this.costStore.getSessionSummary(session.id);
      const totalCost = costSummary.reduce((sum, s) => sum + s.totalCost, 0);
      const totalTokens = costSummary.reduce(
        (sum, s) => sum + s.totalInputTokens + s.totalOutputTokens,
        0,
      );

      this.sessionStore.complete(session.id, finalOutput.slice(0, 500));
      this.sessionStore.addUsage(session.id, totalCost, totalTokens);

      const durationMs = Date.now() - startTime;

      this.eventBus.emitEvent({
        type: 'session.completed',
        sessionId: session.id,
        finalOutput,
        totalCost,
        totalTokens,
        durationMs,
        timestamp: new Date().toISOString(),
      });

      return {
        sessionId: session.id,
        status: 'completed',
        finalOutput,
        totalCost,
        totalTokens,
        durationMs,
        iterations: totalIterations,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.sessionStore.updateStatus(session.id, 'failed');

      this.eventBus.emitEvent({
        type: 'session.failed',
        sessionId: session.id,
        error: errorMessage,
        lastStep: currentStep,
        timestamp: new Date().toISOString(),
      });

      return {
        sessionId: session.id,
        status: 'failed',
        finalOutput: '',
        totalCost: 0,
        totalTokens: 0,
        durationMs: Date.now() - startTime,
        iterations: 0,
        error: errorMessage,
        lastStep: currentStep,
      };
    }
  }
}
