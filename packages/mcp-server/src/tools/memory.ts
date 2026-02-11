// packages/mcp-server/src/tools/memory.ts — codemoot_memory tool handler

import { memoryInputSchema } from '@codemoot/core';
import type { MemoryStore } from '@codemoot/core';

export async function handleMemory(memoryStore: MemoryStore, projectId: string, args: unknown) {
  const input = memoryInputSchema.parse(args);
  let result: unknown;

  switch (input.action) {
    case 'save': {
      if (!input.content) {
        throw new Error('content is required for save action');
      }
      const id = memoryStore.save({
        projectId,
        category: input.category ?? 'convention',
        content: input.content,
        sourceSessionId: null,
        importance: input.importance,
      });
      result = { id, saved: true };
      break;
    }
    case 'search': {
      if (!input.query) {
        throw new Error('query is required for search action');
      }
      const records = memoryStore.search(input.query, projectId);
      result = { records, count: records.length };
      break;
    }
    case 'get': {
      if (input.memoryId === undefined) {
        throw new Error('memoryId is required for get action');
      }
      const record = memoryStore.getById(input.memoryId);
      if (record) {
        memoryStore.recordAccess(input.memoryId);
      }
      result = record ?? { error: 'Not found' };
      break;
    }
    case 'delete': {
      if (input.memoryId === undefined) {
        throw new Error('memoryId is required for delete action');
      }
      memoryStore.delete(input.memoryId);
      result = { deleted: true, memoryId: input.memoryId };
      break;
    }
    default: {
      throw new Error(`Unknown memory action: ${String(input.action)}`);
    }
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}
