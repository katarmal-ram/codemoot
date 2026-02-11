// packages/mcp-server/src/tools/review.ts — codemoot_review tool handler

import { reviewInputSchema } from '@codemoot/core';
import type { CancellationToken, Orchestrator } from '@codemoot/core';

export async function handleReview(
  orchestrator: Orchestrator,
  args: unknown,
  cancellationToken?: CancellationToken,
) {
  const input = reviewInputSchema.parse(args);
  const result = await orchestrator.review(
    input.content,
    {
      criteria: input.criteria,
      strict: input.strict,
      timeout: input.timeout,
    },
    cancellationToken,
  );
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
