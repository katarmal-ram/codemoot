// packages/mcp-server/src/tools/cost.ts — codemoot_cost tool handler

import { DAYS_PER_YEAR, costInputSchema } from '@codemoot/core';
import type { CostStore } from '@codemoot/core';

export async function handleCost(costStore: CostStore, args: unknown) {
  const input = costInputSchema.parse(args);
  let result: unknown;

  switch (input.scope) {
    case 'session': {
      const sessionId = input.sessionId ?? '';
      result = costStore.getSessionSummary(sessionId);
      break;
    }
    case 'daily': {
      result = costStore.getDailySummary(input.days);
      break;
    }
    case 'all': {
      result = costStore.getDailySummary(DAYS_PER_YEAR);
      break;
    }
    default: {
      throw new Error(`Unknown cost scope: ${String(input.scope)}`);
    }
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
