// packages/mcp-server/src/tools/plan.ts — codemoot_plan tool handler

import { planInputSchema } from '@codemoot/core';
import type { Orchestrator } from '@codemoot/core';

export async function handlePlan(orchestrator: Orchestrator, args: unknown) {
  const input = planInputSchema.parse(args);
  const result = await orchestrator.plan(input.task, {
    maxRounds: input.maxRounds,
    stream: input.stream,
  });
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
