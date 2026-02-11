// packages/core/src/utils/sleep.ts — Shared async delay utility

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
