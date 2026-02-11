// packages/mcp-server/src/tools/debate.ts — codemoot_debate tool handler

import { debateInputSchema } from '@codemoot/core';
import type { Orchestrator } from '@codemoot/core';

export async function handleDebate(orchestrator: Orchestrator, args: unknown) {
  const input = debateInputSchema.parse(args);
  const result = await orchestrator.debateMultiRound(input.question, {
    modelAliases: input.models,
    maxRounds: input.maxRounds,
    timeout: input.timeout,
  });
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
