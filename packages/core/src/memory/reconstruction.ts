// packages/core/src/memory/reconstruction.ts — Build reconstruction prompts from stored debate history

import type { DebateMessageRow } from './message-store.js';

/**
 * Build a reconstruction preamble from stored debate messages.
 * Used when session resume fails and we need to give GPT context of previous rounds.
 *
 * Strategy:
 * - If history fits within tokenBudget: include all rounds verbatim
 * - If over budget: summarize oldest rounds, keep newest verbatim
 *
 * @param history - Previous completed messages from MessageStore.getHistory()
 * @param currentPrompt - The new prompt for this round
 * @param maxChars - Approximate character budget (rough proxy for tokens; ~4 chars/token)
 * @returns The reconstructed prompt with history preamble
 */
export function buildReconstructionPrompt(
  history: DebateMessageRow[],
  currentPrompt: string,
  maxChars = 100_000,
): string {
  const completed = history.filter(m => m.status === 'completed' && m.responseText);

  if (completed.length === 0) {
    return currentPrompt;
  }

  // Build verbatim history blocks
  const blocks: string[] = [];
  for (const msg of completed) {
    blocks.push(
      `## Round ${msg.round} (${msg.role})\n**Prompt:** ${truncate(msg.promptText, 500)}\n**Response:** ${msg.responseText}${msg.stance ? `\n**Stance:** ${msg.stance}` : ''}`,
    );
  }

  const preamble = `This is a continuation of a debate. The session was interrupted and context must be reconstructed from the conversation ledger.\n\n# Previous Rounds\n\n${blocks.join('\n\n')}\n\n# Current Round\n\n`;
  const full = preamble + currentPrompt;

  // If within budget, return full
  if (full.length <= maxChars) {
    return full;
  }

  // Over budget: summarize oldest rounds, keep newest verbatim
  return buildCompressedPrompt(completed, currentPrompt, maxChars);
}

function buildCompressedPrompt(
  history: DebateMessageRow[],
  currentPrompt: string,
  maxChars: number,
): string {
  // Keep newest rounds verbatim, summarize oldest
  const verbatimCount = Math.max(1, Math.min(3, Math.floor(history.length / 2)));
  const toSummarize = history.slice(0, -verbatimCount);
  const toKeep = history.slice(-verbatimCount);

  const summaryParts: string[] = [];
  for (const msg of toSummarize) {
    const stanceStr = msg.stance ? ` (${msg.stance})` : '';
    summaryParts.push(`- Round ${msg.round}: ${truncate(msg.responseText ?? '', 200)}${stanceStr}`);
  }

  const verbatimParts: string[] = [];
  for (const msg of toKeep) {
    verbatimParts.push(
      `## Round ${msg.round} (${msg.role})\n**Response:** ${msg.responseText}${msg.stance ? `\n**Stance:** ${msg.stance}` : ''}`,
    );
  }

  let result = `This is a continuation of a debate. Context reconstructed from ledger.\n\n# Summary of Earlier Rounds\n${summaryParts.join('\n')}\n\n# Recent Rounds (verbatim)\n\n${verbatimParts.join('\n\n')}\n\n# Current Round\n\n${currentPrompt}`;

  // If still over budget, aggressively truncate summaries
  if (result.length > maxChars) {
    result = `Context reconstructed from ledger (truncated).\n\n# Most Recent Round\n\n${verbatimParts[verbatimParts.length - 1]}\n\n# Current Round\n\n${currentPrompt}`;
  }

  return result.slice(0, maxChars);
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}... [truncated]`;
}
