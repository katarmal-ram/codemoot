// packages/core/src/context/context-builder.ts — Assembles enriched prompts with memory + codebase context

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryStore } from '../memory/memory-store.js';
import type { MemoryRecord } from '../types/memory.js';
import { CONTEXT_ACTIVE, CONTEXT_BUFFER, CONTEXT_RETRIEVED } from '../utils/constants.js';

/** Token budget tiers for context assembly. */
export interface ContextBudget {
  /** Max tokens for tier 1: task + memories. Default 2000 */
  tier1: number;
  /** Max tokens for tier 2: file tree + snippets. Default 4000 */
  tier2: number;
  /** Max total tokens for assembled context. Default 8000 */
  total: number;
}

export interface ContextBuilderOptions {
  projectDir?: string;
  projectId?: string;
  memoryStore?: MemoryStore;
  budget?: Partial<ContextBudget>;
  /** Max depth for file tree traversal. Default 3 */
  maxTreeDepth?: number;
  /** Max number of files to include in tree. Default 200 */
  maxFiles?: number;
  /** File extensions to include in tree. Default: common code extensions */
  includeExtensions?: string[];
}

export interface AssembledContext {
  /** The enriched prompt with context prepended */
  prompt: string;
  /** Memories that were injected */
  memories: MemoryRecord[];
  /** File tree summary (if generated) */
  fileTree: string;
  /** Estimated token count of the assembled context */
  estimatedTokens: number;
}

const DEFAULT_BUDGET: ContextBudget = {
  tier1: CONTEXT_BUFFER,
  tier2: CONTEXT_RETRIEVED,
  total: CONTEXT_ACTIVE,
};

const DEFAULT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.swift',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.md',
]);

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'target',
  'vendor',
]);

/**
 * Builds enriched prompts by assembling relevant context from:
 * - Tier 1: Task framing + relevant memories from SQLite FTS
 * - Tier 2: Project file tree + relevant code snippets
 * - Tier 3: (Future) On-demand expansion when model requests more context
 */
export class ContextBuilder {
  private projectDir: string | undefined;
  private projectId: string;
  private memoryStore: MemoryStore | undefined;
  private budget: ContextBudget;
  private maxTreeDepth: number;
  private maxFiles: number;
  private includeExtensions: Set<string>;

  constructor(options: ContextBuilderOptions) {
    this.projectDir = options.projectDir;
    this.projectId = options.projectId ?? 'default';
    this.memoryStore = options.memoryStore;
    this.budget = { ...DEFAULT_BUDGET, ...options.budget };
    this.maxTreeDepth = options.maxTreeDepth ?? 3;
    this.maxFiles = options.maxFiles ?? 200;
    this.includeExtensions = options.includeExtensions
      ? new Set(options.includeExtensions)
      : DEFAULT_EXTENSIONS;
  }

  /**
   * Assemble enriched context for a model call.
   * @param taskPrompt The original prompt/task
   * @param taskType Context about what kind of task (review, debate, plan)
   */
  assemble(taskPrompt: string, taskType?: string): AssembledContext {
    const sections: string[] = [];
    let totalChars = 0;
    const memories: MemoryRecord[] = [];

    // -- Tier 1: Memories --
    if (this.memoryStore) {
      const tier1Budget = this.budget.tier1 * 4; // chars (rough token-to-char ratio)
      const relevantMemories = this.queryMemories(taskPrompt, tier1Budget);
      if (relevantMemories.length > 0) {
        const memorySection = this.formatMemories(relevantMemories);
        sections.push(memorySection);
        totalChars += memorySection.length;
        memories.push(...relevantMemories);
      }
    }

    // -- Tier 2: File tree + project context --
    let fileTree = '';
    if (this.projectDir && totalChars < this.budget.total * 4) {
      const tier2Budget = Math.min(this.budget.tier2 * 4, this.budget.total * 4 - totalChars);

      fileTree = this.buildFileTree();
      if (fileTree && fileTree.length <= tier2Budget) {
        const treeSection = `## Project Structure\n\`\`\`\n${fileTree}\`\`\``;
        sections.push(treeSection);
        totalChars += treeSection.length;
      }
    }

    // -- Assemble final prompt --
    const contextPrefix = sections.length > 0 ? `${sections.join('\n\n')}\n\n---\n\n` : '';

    // Add task type framing if provided
    const taskFrame = taskType ? `[Task type: ${taskType}]\n\n` : '';

    const prompt = `${contextPrefix}${taskFrame}${taskPrompt}`;
    const estimatedTokens = Math.ceil(prompt.length / 4);

    return {
      prompt,
      memories,
      fileTree,
      estimatedTokens,
    };
  }

  /** Query relevant memories using FTS5 search. */
  private queryMemories(query: string, charBudget: number): MemoryRecord[] {
    if (!this.memoryStore) return [];

    // Extract key terms from the query for FTS search
    const searchTerms = this.extractSearchTerms(query);
    if (!searchTerms) return [];

    const results = this.memoryStore.search(searchTerms, this.projectId, 10);

    // Select memories within budget, prioritizing by importance
    const sorted = results.sort((a, b) => b.importance - a.importance);
    const selected: MemoryRecord[] = [];
    let usedChars = 0;

    for (const memory of sorted) {
      const entryChars = memory.content.length + 30; // overhead for formatting
      if (usedChars + entryChars > charBudget) break;
      selected.push(memory);
      usedChars += entryChars;

      // Record access for memory decay tracking
      if (memory.id) {
        this.memoryStore.recordAccess(memory.id);
      }
    }

    return selected;
  }

  /** Extract meaningful search terms from a prompt. */
  private extractSearchTerms(query: string): string {
    // Remove common stop words and keep meaningful terms
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'can',
      'shall',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'this',
      'that',
      'these',
      'those',
      'it',
      'its',
      'and',
      'or',
      'but',
      'not',
      'no',
      'if',
      'then',
      'else',
      'when',
      'how',
      'what',
      'which',
      'who',
      'whom',
      'where',
      'why',
      'review',
      'following',
      'content',
      'carefully',
      'provide',
      'score',
      'feedback',
      'verdict',
    ]);

    const terms = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !stopWords.has(t));

    // Take top 5 unique terms
    const unique = [...new Set(terms)].slice(0, 5);
    return unique.join(' ');
  }

  /** Format memories for injection into prompt. */
  private formatMemories(memories: MemoryRecord[]): string {
    const lines = memories.map((m) => `- [${m.category}] ${m.content}`);
    return `## Project Context (from memory)\n${lines.join('\n')}`;
  }

  /** Build a compact file tree of the project, capped at maxFiles entries. */
  buildFileTree(): string {
    if (!this.projectDir) return '';

    try {
      const lines: string[] = [];
      const counter = { value: 0 };
      this.walkDir(this.projectDir, '', 0, lines, counter);
      if (counter.value >= this.maxFiles) {
        lines.push(`[... truncated at ${this.maxFiles} files]`);
      }
      return lines.join('\n');
    } catch {
      return '';
    }
  }

  private walkDir(
    dir: string,
    prefix: string,
    depth: number,
    lines: string[],
    counter: { value: number },
  ): void {
    if (depth > this.maxTreeDepth) return;
    if (counter.value >= this.maxFiles) return;

    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }

    // Separate dirs and files
    const dirs: string[] = [];
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.cowork.yml') continue;
      if (IGNORE_DIRS.has(entry)) continue;

      try {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          dirs.push(entry);
        } else if (this.shouldIncludeFile(entry)) {
          files.push(entry);
        }
      } catch {
        // Skip inaccessible entries
      }
    }

    // Print directories first, then files
    for (const d of dirs) {
      if (counter.value >= this.maxFiles) return;
      lines.push(`${prefix}${d}/`);
      this.walkDir(join(dir, d), `${prefix}  `, depth + 1, lines, counter);
    }
    for (const f of files) {
      if (counter.value >= this.maxFiles) return;
      lines.push(`${prefix}${f}`);
      counter.value++;
    }
  }

  private shouldIncludeFile(filename: string): boolean {
    const dotIdx = filename.lastIndexOf('.');
    if (dotIdx < 0) return false;
    return this.includeExtensions.has(filename.slice(dotIdx));
  }

  /**
   * Read a specific file's content within token budget.
   * Useful for tier 3 on-demand context expansion.
   */
  readFileContent(filePath: string, maxChars = 8000): string | null {
    if (!this.projectDir) return null;
    try {
      const fullPath = join(this.projectDir, filePath);
      const content = readFileSync(fullPath, 'utf-8');
      if (content.length > maxChars) {
        return `${content.slice(0, maxChars)}\n[TRUNCATED: file exceeds ${maxChars} chars]`;
      }
      return content;
    } catch {
      return null;
    }
  }
}

// ── Handoff Envelope ──

/** Command types with pre-defined output contracts. */
export type HandoffCommand = 'review' | 'debate' | 'build-review' | 'cleanup' | 'adjudicate' | 'custom';

export interface HandoffEnvelopeOptions {
  /** The command being executed */
  command: HandoffCommand;
  /** The core task/instruction for GPT */
  task: string;
  /** Focus area or constraints */
  constraints?: string[];
  /** Whether this is a resumed session (GPT already has prior context) */
  resumed: boolean;
  /** Brief summary of what happened in prior turns (from session events) */
  priorContext?: string;
  /** Scope restriction (glob pattern) */
  scope?: string;
}

/** Output contract templates per command type. */
const OUTPUT_CONTRACTS: Record<HandoffCommand, string> = {
  review: `For each issue found, format as:
- CRITICAL: <file>:<line> <description>
- WARNING: <file>:<line> <description>
- INFO: <file>:<line> <description>

End with:
VERDICT: APPROVED or VERDICT: NEEDS_REVISION
SCORE: X/10`,

  'build-review': `For each issue found, format as:
- BUG: <description>
- ISSUE: <description>

End with:
- VERDICT: APPROVED (if code is ready) or VERDICT: NEEDS_REVISION (if fixes needed)
- SCORE: X/10`,

  cleanup: `For each issue found, output in this EXACT format (one per line):
FINDING: <scope>|<confidence>|<file>|<line>|<symbol>|<description>|<recommendation>

Output SCAN_COMPLETE when done.`,

  adjudicate: `Respond with exactly one line:
ADJUDICATE: CONFIRMED|DISMISSED|UNCERTAIN <reason>`,

  debate: `State your position clearly, then end with:
STANCE: SUPPORT | OPPOSE | NEUTRAL
CONFIDENCE: X/10`,

  custom: '',
};

/**
 * Build a structured handoff envelope for Claude→GPT communication.
 *
 * Wraps any command's raw prompt with:
 * 1. Codebase access preamble
 * 2. Resume primer (when continuing a thread)
 * 3. The core task
 * 4. Constraints & scope
 * 5. Output contract
 */
export function buildHandoffEnvelope(options: HandoffEnvelopeOptions): string {
  const sections: string[] = [];

  // ── Preamble ──
  sections.push('You have full access to this project\'s codebase. Use tools to discover, read, and analyze relevant files as needed.');

  // ── Resume primer (capped at 500 chars to prevent bloat) ──
  if (options.resumed) {
    const context = options.priorContext ? options.priorContext.slice(0, 500) : '';
    const primer = context
      ? `Continue from prior thread. Prior context: ${context}\nDo not repeat completed analysis — focus on unresolved items or the new task below.`
      : 'Continue from prior thread. Do not repeat completed analysis — focus on the new task below.';
    sections.push(primer);
  }

  // ── Task (capped at 60K chars — codex has 400K context but leave room for tools) ──
  sections.push(options.task.slice(0, 60_000));

  // ── Constraints ──
  const constraints: string[] = options.constraints ? [...options.constraints] : [];
  if (options.scope) {
    constraints.push(`Restrict exploration to files matching: ${options.scope}`);
  }
  if (constraints.length > 0) {
    sections.push(`CONSTRAINTS:\n${constraints.map(c => `- ${c}`).join('\n')}`);
  }

  // ── Output contract ──
  const contract = OUTPUT_CONTRACTS[options.command];
  if (contract) {
    sections.push(contract);
  }

  return sections.join('\n\n');
}
