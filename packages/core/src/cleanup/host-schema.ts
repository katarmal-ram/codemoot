// packages/core/src/cleanup/host-schema.ts — Zod schema for host AI findings input

import { z } from 'zod';

const scopeSchema = z.enum(['deps', 'unused-exports', 'hardcoded', 'duplicates', 'deadcode']);

/** Scope-specific symbol validation patterns */
const symbolPatterns: Record<string, RegExp> = {
  deps: /^[@a-z0-9][\w./@-]*$/i,
  'unused-exports': /^[$_a-z][\w$]*$/i,
  hardcoded: /^(num:[^:]+:L\d+|url:[^:]+:L\d+|cred:L\d+)$/,
  duplicates: /^[a-f0-9]{8}:[\w$]+$/i,
  deadcode: /^[$_a-z][\w$]*$/i,
};

const hostFindingSchema = z.object({
  scope: scopeSchema,
  confidence: z.enum(['high', 'medium', 'low']),
  file: z.string().min(1),
  line: z.number().int().nonnegative().optional(),
  symbol: z.string().min(1),
  description: z.string().min(1),
  recommendation: z.string().min(1),
}).refine(
  (data) => {
    const pattern = symbolPatterns[data.scope];
    return pattern ? pattern.test(data.symbol) : true;
  },
  (data) => ({
    message: `Symbol "${data.symbol}" does not match expected pattern for scope "${data.scope}"`,
  }),
);

export const hostFindingsSchema = z.array(hostFindingSchema);

export type HostFindingInput = z.infer<typeof hostFindingSchema>;
