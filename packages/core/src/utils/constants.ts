// packages/core/src/utils/constants.ts — Shared magic number constants

/** Default timeout for model calls in seconds */
export const DEFAULT_TIMEOUT_SEC = 600;

/** Default cleanup scan timeout in seconds */
export const CLEANUP_TIMEOUT_SEC = 1200;

/** Default max tokens for model output */
export const DEFAULT_MAX_TOKENS = 4096;

/** Implementer max tokens (larger for code generation) */
export const IMPLEMENTER_MAX_TOKENS = 8192;

/** Max content length for MCP review input */
export const MCP_CONTENT_MAX_LENGTH = 100000;

/** Max content length for MCP task/question input */
export const MCP_TASK_MAX_LENGTH = 50000;

/** Max timeout for MCP tool calls in seconds */
export const MCP_TIMEOUT_MAX = 900;

/** HTTP 429 Too Many Requests status code */
export const HTTP_TOO_MANY_REQUESTS = 429;

/** Days in a year (for cost aggregation) */
export const DAYS_PER_YEAR = 365;

/** Max diff size sent to reviewer */
export const REVIEW_DIFF_MAX_CHARS = 50000;

/** Max review text stored in DB */
export const REVIEW_TEXT_MAX_CHARS = 5000;

/** Binary detection buffer size */
export const BINARY_SNIFF_BYTES = 512;

/** Context budget defaults */
export const CONTEXT_ACTIVE = 8000;
export const CONTEXT_RETRIEVED = 4000;
export const CONTEXT_BUFFER = 2000;

/** DLP max content length */
export const DLP_MAX_CONTENT = 2000;

/** DLP max processing time in milliseconds */
export const DLP_MAX_PROCESSING_MS = 2000;
