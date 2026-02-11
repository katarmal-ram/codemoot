// packages/core/src/utils/id.ts

import { nanoid } from 'nanoid';

/** Generate a session ID with "ses_" prefix. */
export function generateSessionId(): string {
  return `ses_${nanoid(21)}`;
}

/** Generate a generic unique ID. */
export function generateId(prefix?: string): string {
  const id = nanoid(16);
  return prefix ? `${prefix}_${id}` : id;
}
