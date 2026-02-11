// packages/core/src/engine/debate-engine.ts — Multi-round debate with proposal-critique pattern

import { nanoid } from 'nanoid';
import type {
  CompactionPolicy,
  ConvergencePolicy,
  DebateBudget,
  DebateEngineInput,
  DebateEngineResult,
  DebateEngineState,
  DebateIO,
  DebateMessage,
  DebateMessageKind,
  Stance,
  StopDecision,
  StopReason,
} from '../types/debate.js';

// ── Defaults ──

const DEFAULT_BUDGET: DebateBudget = {
  maxRounds: 3,
  maxWallClockMs: 110_000,
  perTurnTimeoutMs: 60_000,
};

const DEFAULT_CONVERGENCE: ConvergencePolicy = {
  minRoundsBeforeCheck: 1,
  requiredStableRounds: 2,
};

const DEFAULT_COMPACTION: CompactionPolicy = {
  keepRecentMessages: 4,
  summaryMaxTokens: 500,
};

// ── Stance detection ──

const SUPPORT_PATTERNS = [
  /\bapproved?\b/i,
  /\bagree[sd]?\b/i,
  /\bsupport/i,
  /\blooks?\s+good\b/i,
  /\bno\s+(major\s+)?issues?\b/i,
  /\bwell[\s-]designed\b/i,
  /\bverdict:\s*approved/i,
];

const OPPOSE_PATTERNS = [
  /\bneeds?\s+revision/i,
  /\bdisagree/i,
  /\boppose/i,
  /\breject/i,
  /\bfundamental(ly)?\s+(flaw|issue|problem)/i,
  /\bverdict:\s*needs.revision/i,
  /\bsignificant\s+(concern|issue|problem)/i,
];

export function detectStance(text: string): Stance {
  let supportScore = 0;
  let opposeScore = 0;

  for (const p of SUPPORT_PATTERNS) {
    if (p.test(text)) supportScore++;
  }
  for (const p of OPPOSE_PATTERNS) {
    if (p.test(text)) opposeScore++;
  }

  if (supportScore > opposeScore) return 'support';
  if (opposeScore > supportScore) return 'oppose';
  return 'uncertain';
}

// ── Engine ──

export class ProposalCritiqueEngine {
  private budget: DebateBudget;
  private convergence: ConvergencePolicy;
  private compaction: CompactionPolicy;

  constructor(
    budget?: Partial<DebateBudget>,
    convergence?: Partial<ConvergencePolicy>,
    compaction?: Partial<CompactionPolicy>,
  ) {
    this.budget = { ...DEFAULT_BUDGET, ...budget };
    this.convergence = { ...DEFAULT_CONVERGENCE, ...convergence };
    this.compaction = { ...DEFAULT_COMPACTION, ...compaction };
  }

  /** Initialize debate state. */
  init(input: DebateEngineInput): DebateEngineState {
    if (input.models.length < 2) {
      throw new Error('Proposal-critique debate requires at least 2 models');
    }
    return {
      debateId: input.debateId,
      question: input.question,
      models: input.models,
      round: 0,
      turn: 0,
      thread: [
        {
          id: nanoid(),
          turn: 0,
          round: 0,
          speakerId: 'user',
          kind: 'topic',
          text: input.question,
          createdAt: Date.now(),
        },
      ],
      runningSummary: '',
      stanceHistory: [],
      usage: {
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCalls: 0,
        startedAt: Date.now(),
      },
      status: 'running',
      sessionIds: {},
      resumeStats: { attempted: 0, succeeded: 0, fallbacks: 0 },
    };
  }

  /** Run the full debate loop. */
  async run(input: DebateEngineInput, io: DebateIO): Promise<DebateEngineResult> {
    const state = this.init(input);

    let stopReason: StopReason = 'max_rounds';

    for (let round = 1; round <= this.budget.maxRounds; round++) {
      state.round = round;

      // Step 1: Proposer turn
      const proposerAlias = state.models[0];
      const proposerKind: DebateMessageKind = round === 1 ? 'proposal' : 'rebuttal';
      await this.executeTurn(state, io, proposerAlias, proposerKind);

      // Check time budget
      const timeCheck = this.checkTimeBudget(state);
      if (timeCheck.stop) {
        stopReason = 'time_budget';
        break;
      }

      // Step 2: Critic turn
      const criticAlias = state.models[1];
      await this.executeTurn(state, io, criticAlias, 'critique');

      // Check convergence
      const decision = this.shouldStop(state);
      if (decision.stop) {
        stopReason = decision.reason ?? 'converged';
        break;
      }

      // Step 3: Update running summary (use critic model — cheaper to ask for summary)
      if (round < this.budget.maxRounds) {
        await this.updateSummary(state, io);
      }
    }

    state.status = 'stopped';
    return this.finalize(state, stopReason);
  }

  /** Execute a single turn: build prompt, call model, record message. */
  private async executeTurn(
    state: DebateEngineState,
    io: DebateIO,
    modelAlias: string,
    kind: DebateMessageKind,
  ): Promise<DebateMessage> {
    state.turn++;
    const existingSessionId = state.sessionIds[modelAlias];
    const prompt = this.buildTurnPrompt(state, modelAlias, kind);

    if (existingSessionId) {
      state.resumeStats.attempted++;
    }

    const result = await io.generate(
      modelAlias,
      [
        { role: 'system', content: this.getSystemPrompt(kind) },
        { role: 'user', content: prompt },
      ],
      this.budget.perTurnTimeoutMs,
      existingSessionId,
    );

    // Track session ID for resume
    if (result.sessionId) {
      if (existingSessionId && result.sessionId === existingSessionId) {
        state.resumeStats.succeeded++;
      } else if (existingSessionId && result.sessionId !== existingSessionId) {
        state.resumeStats.fallbacks++;
      }
      state.sessionIds[modelAlias] = result.sessionId;
    }

    const stance = detectStance(result.text);
    const message: DebateMessage = {
      id: nanoid(),
      turn: state.turn,
      round: state.round,
      speakerId: modelAlias,
      kind,
      text: result.text,
      stance,
      confidence: this.extractConfidence(result.text),
      tokens: { prompt: result.promptTokens, completion: result.completionTokens },
      createdAt: Date.now(),
    };

    state.thread.push(message);
    state.stanceHistory.push({ round: state.round, speakerId: modelAlias, stance });
    state.usage.totalPromptTokens += result.promptTokens;
    state.usage.totalCompletionTokens += result.completionTokens;
    state.usage.totalCalls++;

    return message;
  }

  /** Build the prompt for a turn with compacted context. */
  private buildTurnPrompt(
    state: DebateEngineState,
    _modelAlias: string,
    kind: DebateMessageKind,
  ): string {
    const parts: string[] = [];

    // Always include the original question
    parts.push(`## Question\n${state.question}`);

    // Include running summary if we have one (compaction)
    if (state.runningSummary) {
      parts.push(`## Discussion Summary So Far\n${state.runningSummary}`);
    }

    // Include recent messages (compacted context window)
    const recentMessages = state.thread.slice(-this.compaction.keepRecentMessages);
    if (recentMessages.length > 0) {
      const msgTexts = recentMessages
        .filter((m) => m.kind !== 'topic') // topic already shown as question
        .map((m) => `**${m.speakerId}** (${m.kind}, round ${m.round}):\n${m.text}`);
      if (msgTexts.length > 0) {
        parts.push(`## Recent Arguments\n${msgTexts.join('\n\n')}`);
      }
    }

    // Role-specific instruction
    if (kind === 'proposal') {
      parts.push(
        '## Your Task\nProvide a thorough proposal/plan to address the question above. Be specific and actionable.',
      );
    } else if (kind === 'rebuttal') {
      parts.push(
        '## Your Task\nRevise your proposal based on the critique above. Address each concern specifically. If you disagree with a point, explain why.',
      );
    } else if (kind === 'critique') {
      parts.push(
        '## Your Task\nCritique the proposal above. Identify weaknesses, missing considerations, and potential improvements. If the proposal is solid, say so explicitly with "VERDICT: APPROVED". Otherwise provide specific, actionable feedback.',
      );
    }

    // Ask for structured stance
    parts.push(
      '## Required Output Format\nEnd your response with exactly one of:\n- STANCE: SUPPORT (if you agree with the current direction)\n- STANCE: OPPOSE (if you have significant concerns)\n- STANCE: UNCERTAIN (if mixed)',
    );

    return parts.join('\n\n');
  }

  /** System prompt based on turn type. */
  private getSystemPrompt(kind: DebateMessageKind): string {
    if (kind === 'proposal' || kind === 'rebuttal') {
      return 'You are an expert architect. Provide clear, well-reasoned proposals. Address feedback directly. Always end with your STANCE.';
    }
    return 'You are a critical reviewer. Be thorough but fair. Approve good work, critique weak points. Always end with your STANCE.';
  }

  /** Check if we should stop the debate. */
  shouldStop(state: DebateEngineState): StopDecision {
    // Hard limit: time
    const timeCheck = this.checkTimeBudget(state);
    if (timeCheck.stop) return timeCheck;

    // Hard limit: rounds
    if (state.round >= this.budget.maxRounds) {
      return { stop: true, reason: 'max_rounds' };
    }

    // Convergence: check if critic supports for requiredStableRounds
    if (state.round >= this.convergence.minRoundsBeforeCheck) {
      const criticAlias = state.models[1];
      const criticStances = state.stanceHistory
        .filter((s) => s.speakerId === criticAlias)
        .slice(-this.convergence.requiredStableRounds);

      if (
        criticStances.length >= this.convergence.requiredStableRounds &&
        criticStances.every((s) => s.stance === 'support')
      ) {
        return {
          stop: true,
          reason: 'converged',
          diagnostics: { stableRounds: criticStances.length },
        };
      }
    }

    return { stop: false };
  }

  /** Check time budget. */
  private checkTimeBudget(state: DebateEngineState): StopDecision {
    const elapsed = Date.now() - state.usage.startedAt;
    const remaining = this.budget.maxWallClockMs - elapsed;
    if (remaining <= 0) {
      return {
        stop: true,
        reason: 'time_budget',
        diagnostics: { elapsedMs: elapsed, remainingMs: 0 },
      };
    }
    return { stop: false, diagnostics: { remainingMs: remaining } };
  }

  /** Update the running summary to compact older context. */
  private async updateSummary(state: DebateEngineState, io: DebateIO): Promise<void> {
    // Use the first model (proposer) to summarize
    const summarizerAlias = state.models[0];

    // Gather the round's messages
    const roundMessages = state.thread
      .filter((m) => m.round === state.round && m.kind !== 'topic')
      .map((m) => `${m.speakerId} (${m.kind}): ${m.text}`)
      .join('\n\n');

    const prevSummary = state.runningSummary ? `Previous summary: ${state.runningSummary}\n\n` : '';

    const prompt = `${prevSummary}New round of discussion:\n${roundMessages}\n\nWrite a brief summary (max 3 paragraphs) of the current state of the debate. What has been proposed, what concerns were raised, and what remains unresolved?`;

    const result = await io.generate(
      summarizerAlias,
      [
        {
          role: 'system',
          content:
            'Summarize debate progress concisely. Focus on key proposals, critiques, and unresolved points.',
        },
        { role: 'user', content: prompt },
      ],
      this.budget.perTurnTimeoutMs,
    );

    state.runningSummary = result.text;
    state.usage.totalPromptTokens += result.promptTokens;
    state.usage.totalCompletionTokens += result.completionTokens;
    state.usage.totalCalls++;

    // Record summary as a message
    state.thread.push({
      id: nanoid(),
      turn: ++state.turn,
      round: state.round,
      speakerId: 'moderator',
      kind: 'summary',
      text: result.text,
      createdAt: Date.now(),
    });
  }

  /** Build the final result from state. */
  private finalize(state: DebateEngineState, reason: StopReason): DebateEngineResult {
    // Find the last substantive message (proposal/rebuttal/critique) as the answer
    const substantive = state.thread.filter(
      (m) => m.kind === 'proposal' || m.kind === 'rebuttal' || m.kind === 'critique',
    );
    const lastProposal = [...substantive]
      .reverse()
      .find((m) => m.kind === 'proposal' || m.kind === 'rebuttal');
    const lastCritique = [...substantive].reverse().find((m) => m.kind === 'critique');

    // If converged, the last proposal is the answer. Otherwise, include the critique too.
    let answer: string;
    if (reason === 'converged' && lastProposal) {
      answer = lastProposal.text;
    } else if (lastProposal && lastCritique) {
      answer = `## Final Proposal\n${lastProposal.text}\n\n## Outstanding Critique\n${lastCritique.text}`;
    } else {
      answer = substantive.at(-1)?.text ?? state.question;
    }

    return {
      debateId: state.debateId,
      answer,
      reason,
      rounds: state.round,
      thread: state.thread,
      stanceHistory: state.stanceHistory,
      usage: state.usage,
    };
  }

  /** Extract confidence value from text if present. */
  private extractConfidence(text: string): number | undefined {
    const match = /confidence:\s*([\d.]+)/i.exec(text);
    if (match) {
      const val = Number.parseFloat(match[1]);
      if (val >= 0 && val <= 1) return val;
      if (val >= 0 && val <= 100) return val / 100;
    }
    return undefined;
  }
}

export { DEFAULT_BUDGET, DEFAULT_CONVERGENCE, DEFAULT_COMPACTION };
