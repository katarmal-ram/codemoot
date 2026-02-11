// packages/core/src/cleanup/index.ts — barrel export

export {
  scanUnusedDeps,
  scanUnusedExports,
  scanHardcoded,
  scanDuplicates,
  scanDeadCode,
  scanSecurity,
  scanNearDuplicates,
  scanAntiPatterns,
  runAllScanners,
} from './scanners.js';

export {
  mergeThreeWay,
  mergeTwoWay,
  computeThreeWayStats,
  computeTwoWayStats,
  recalculateConfidenceStats,
} from './merge.js';

export { hostFindingsSchema } from './host-schema.js';
export type { HostFindingInput } from './host-schema.js';
