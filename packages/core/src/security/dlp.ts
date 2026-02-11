// packages/core/src/security/dlp.ts — 6-stage DLP pipeline from MCP architecture

import { DlpReasonCode } from '../types/mcp.js';
import { DLP_MAX_PROCESSING_MS } from '../utils/constants.js';

export type DlpMode = 'strict' | 'open';

export interface DlpRedaction {
  stage: number;
  reasonCode: DlpReasonCode;
  original: string;
  replacement: string;
}

export interface DlpAuditEntry {
  stage: number;
  action: string;
  detail: string;
  timestamp: string;
}

export interface DlpResult {
  sanitized: string;
  redactions: DlpRedaction[];
  truncated: boolean;
  auditLog: DlpAuditEntry[];
}

export interface DlpConfig {
  mode: DlpMode;
  maxInputBytes: number;
  maxProcessingMs: number;
  maxRegexOps: number;
  maxTokens: number;
}

const DEFAULT_DLP_CONFIG: DlpConfig = {
  mode: 'strict',
  maxInputBytes: 5 * 1024 * 1024,
  maxProcessingMs: DLP_MAX_PROCESSING_MS,
  maxRegexOps: 1000,
  maxTokens: 32_000,
};

// -- Secret patterns: [regex, replacement type] --
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/g, 'AWS_KEY'],
  [/sk-proj-[a-zA-Z0-9\-_]{20,}/g, 'API_KEY'],
  [/sk-[a-zA-Z0-9]{20,}/g, 'API_KEY'],
  [/ghp_[a-zA-Z0-9]{36}/g, 'GITHUB_TOKEN'],
  [/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+/g, 'JWT'],
  [/-----BEGIN [A-Z ]+ PRIVATE KEY-----/g, 'PRIVATE_KEY'],
  [/Bearer [a-zA-Z0-9._~+/=-]{20,}/g, 'BEARER_TOKEN'],
  [/[a-zA-Z]+:\/\/[^:]+:[^@]+@/g, 'CONNECTION_STRING'],
];

// -- Path patterns --
const ABSOLUTE_PATH_PATTERNS: RegExp[] = [
  /[A-Z]:\\[^\s'"`,;)}\]]+/g,
  /\/(?:home|Users|root|var|etc|opt|tmp)\/[^\s'"`,;)}\]]+/g,
];

/**
 * Calculate Shannon entropy for a string.
 */
function shannonEntropy(str: string): number {
  if (str.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const ch of str) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }
  return entropy;
}

/**
 * Truncate the original value to first 20 characters for audit safety.
 */
function auditSnippet(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 20)}...`;
}

/**
 * Create an audit log entry.
 */
function audit(stage: number, action: string, detail: string): DlpAuditEntry {
  return {
    stage,
    action,
    detail,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Estimate token count using char/4 heuristic.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Sanitize input through the 6-stage DLP pipeline.
 *
 * Stages:
 *   0: Decode — detect and skip base64/hex (budget-limited)
 *   1: Secrets — regex scan for common secret patterns
 *   2: Entropy — Shannon entropy check on long tokens (strict mode only)
 *   3: Paths — convert absolute paths to relative
 *   4: Context — truncate if exceeding token limit
 *   5: Audit — finalize audit log
 *
 * Risk-tiered defaults:
 *   review/debate tools -> strict mode (external content)
 *   memory/cost tools -> open mode (local data, skip stages 1-2)
 */
export function sanitize(input: string, config?: Partial<DlpConfig>): DlpResult {
  const cfg: DlpConfig = { ...DEFAULT_DLP_CONFIG, ...config };
  const redactions: DlpRedaction[] = [];
  const auditLog: DlpAuditEntry[] = [];
  let text = input;
  let truncated = false;
  const startTime = Date.now();

  /** Check if processing has exceeded the time budget. */
  const isOverBudget = () => Date.now() - startTime > cfg.maxProcessingMs;

  // Budget check: reject oversized input
  const inputBytes = new TextEncoder().encode(text).byteLength;
  if (inputBytes > cfg.maxInputBytes) {
    auditLog.push(audit(0, 'BUDGET_EXCEEDED', `Input size ${inputBytes} exceeds limit`));
    redactions.push({
      stage: 0,
      reasonCode: DlpReasonCode.BUDGET_EXCEEDED,
      original: auditSnippet(text),
      replacement: '[BLOCKED: input exceeds size budget]',
    });
    return {
      sanitized: '[BLOCKED: input exceeds size budget]',
      redactions,
      truncated: true,
      auditLog,
    };
  }

  // Handle empty input early
  if (text.length === 0) {
    return { sanitized: '', redactions: [], truncated: false, auditLog: [] };
  }

  let regexOps = 0;

  // Stage 0: Decode detection (simplified — flag base64 blocks)
  auditLog.push(audit(0, 'DECODE_CHECK', 'Scanning for encoded content'));
  // We detect large base64 blocks and flag them. Per-decode budget: 1MB/10ops/500ms.
  const base64Pattern = /(?:[A-Za-z0-9+/]{4}){16,}={0,2}/g;
  let base64Match = base64Pattern.exec(text);
  while (base64Match && regexOps < cfg.maxRegexOps) {
    regexOps++;
    const matched = base64Match[0];
    // Only flag large base64 blocks (> 64 chars)
    if (matched.length > 64) {
      auditLog.push(
        audit(0, 'DECODE_FLAGGED', `Large base64 block detected: ${matched.length} chars`),
      );
      redactions.push({
        stage: 0,
        reasonCode: DlpReasonCode.DECODE_BLOCKED,
        original: auditSnippet(matched),
        replacement: '[REDACTED:ENCODED_CONTENT]',
      });
      text = `${text.slice(0, base64Match.index)}[REDACTED:ENCODED_CONTENT]${text.slice(base64Match.index + matched.length)}`;
      // Reset regex after modifying text
      base64Pattern.lastIndex = base64Match.index + '[REDACTED:ENCODED_CONTENT]'.length;
    }
    base64Match = base64Pattern.exec(text);
  }

  // In open mode, skip stages 1 and 2 (local data like memory/cost)
  if (cfg.mode === 'strict') {
    // Timer check before stage 1
    if (isOverBudget()) {
      auditLog.push(audit(1, 'TIMEOUT', `Processing exceeded ${cfg.maxProcessingMs}ms budget`));
      return { sanitized: text, redactions, truncated, auditLog };
    }

    // Stage 1: Secret detection
    auditLog.push(audit(1, 'SECRET_SCAN', 'Scanning for secret patterns'));
    for (const [pattern, secretType] of SECRET_PATTERNS) {
      if (regexOps >= cfg.maxRegexOps) break;
      // Reset global regex
      const regex = new RegExp(pattern.source, pattern.flags);
      let match = regex.exec(text);
      while (match && regexOps < cfg.maxRegexOps) {
        regexOps++;
        const original = match[0];
        const replacement = `[REDACTED:${secretType}]`;
        redactions.push({
          stage: 1,
          reasonCode: DlpReasonCode.SECRET_DETECTED,
          original: auditSnippet(original),
          replacement,
        });
        auditLog.push(audit(1, 'SECRET_REDACTED', `${secretType} at position ${match.index}`));
        text = `${text.slice(0, match.index)}${replacement}${text.slice(match.index + original.length)}`;
        // Adjust regex position after replacement
        regex.lastIndex = match.index + replacement.length;
        match = regex.exec(text);
      }
    }

    // Timer check before stage 2
    if (isOverBudget()) {
      auditLog.push(audit(2, 'TIMEOUT', `Processing exceeded ${cfg.maxProcessingMs}ms budget`));
      return { sanitized: text, redactions, truncated, auditLog };
    }

    // Stage 2: Entropy check (strict mode only)
    auditLog.push(audit(2, 'ENTROPY_SCAN', 'Checking token entropy'));
    // Split into tokens by whitespace/punctuation and check each
    const tokenPattern = /[^\s'"`,;)}\]]{21,}/g;
    const tokens: Array<{ value: string; index: number }> = [];
    let tokenMatch = tokenPattern.exec(text);
    while (tokenMatch && regexOps < cfg.maxRegexOps) {
      regexOps++;
      tokens.push({ value: tokenMatch[0], index: tokenMatch.index });
      tokenMatch = tokenPattern.exec(text);
    }

    // Process in reverse order so indices remain valid
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = tokens[i];
      const entropy = shannonEntropy(token.value);
      if (entropy > 4.5) {
        const replacement = '[REDACTED:HIGH_ENTROPY]';
        redactions.push({
          stage: 2,
          reasonCode: DlpReasonCode.HIGH_ENTROPY,
          original: auditSnippet(token.value),
          replacement,
        });
        auditLog.push(
          audit(
            2,
            'ENTROPY_REDACTED',
            `Token entropy ${entropy.toFixed(2)} at position ${token.index}`,
          ),
        );
        text = `${text.slice(0, token.index)}${replacement}${text.slice(token.index + token.value.length)}`;
      }
    }
  } else {
    auditLog.push(audit(1, 'SKIPPED', 'Open mode: secret scan skipped'));
    auditLog.push(audit(2, 'SKIPPED', 'Open mode: entropy scan skipped'));
  }

  // Timer check before stage 3
  if (isOverBudget()) {
    auditLog.push(audit(3, 'TIMEOUT', `Processing exceeded ${cfg.maxProcessingMs}ms budget`));
    return { sanitized: text, redactions, truncated, auditLog };
  }

  // Stage 3: Absolute path conversion
  auditLog.push(audit(3, 'PATH_SCAN', 'Scanning for absolute paths'));
  for (const pathPattern of ABSOLUTE_PATH_PATTERNS) {
    if (regexOps >= cfg.maxRegexOps) break;
    const regex = new RegExp(pathPattern.source, pathPattern.flags);
    let match = regex.exec(text);
    while (match && regexOps < cfg.maxRegexOps) {
      regexOps++;
      const original = match[0];
      const replacement = convertToRelative(original);
      if (replacement !== original) {
        redactions.push({
          stage: 3,
          reasonCode: DlpReasonCode.ABSOLUTE_PATH,
          original: auditSnippet(original),
          replacement,
        });
        auditLog.push(audit(3, 'PATH_CONVERTED', `Absolute path at position ${match.index}`));
        text = `${text.slice(0, match.index)}${replacement}${text.slice(match.index + original.length)}`;
        regex.lastIndex = match.index + replacement.length;
      }
      match = regex.exec(text);
    }
  }

  // Timer check before stage 4
  if (isOverBudget()) {
    auditLog.push(audit(4, 'TIMEOUT', `Processing exceeded ${cfg.maxProcessingMs}ms budget`));
    return { sanitized: text, redactions, truncated, auditLog };
  }

  // Stage 4: Context size truncation
  auditLog.push(audit(4, 'CONTEXT_CHECK', 'Checking token count'));
  const estimatedTokenCount = estimateTokens(text);
  if (estimatedTokenCount > cfg.maxTokens) {
    const maxChars = cfg.maxTokens * 4;
    const truncatedText = text.slice(0, maxChars);
    const suffix = '\n[TRUNCATED: context exceeded token limit]';
    text = truncatedText + suffix;
    truncated = true;
    redactions.push({
      stage: 4,
      reasonCode: DlpReasonCode.CONTEXT_TRUNCATED,
      original: `Estimated ${estimatedTokenCount} tokens`,
      replacement: `Truncated to ${cfg.maxTokens} tokens`,
    });
    auditLog.push(
      audit(
        4,
        'CONTEXT_TRUNCATED',
        `Truncated from ${estimatedTokenCount} to ${cfg.maxTokens} tokens`,
      ),
    );
  }

  // Stage 5: Audit finalization
  auditLog.push(
    audit(
      5,
      'COMPLETE',
      `DLP pipeline complete: ${redactions.length} redactions, truncated=${String(truncated)}`,
    ),
  );

  return {
    sanitized: text,
    redactions,
    truncated,
    auditLog,
  };
}

/**
 * Convert an absolute path to a relative path.
 */
function convertToRelative(absolutePath: string): string {
  // Windows: C:\Users\foo\project\file.ts -> ./project/file.ts
  const winMatch = /^[A-Z]:\\(?:Users\\[^\\]+\\)?(.+)$/i.exec(absolutePath);
  if (winMatch) {
    return `./${winMatch[1].replace(/\\/g, '/')}`;
  }

  // Unix: /home/user/project/file.ts -> ./project/file.ts
  const unixMatch = /^\/(?:home|Users|root)\/[^/]+\/(.+)$/.exec(absolutePath);
  if (unixMatch) {
    return `./${unixMatch[1]}`;
  }

  // Other absolute unix paths: /var/log/app.log -> ./log/app.log
  const otherMatch = /^\/(?:var|etc|opt|tmp)\/(.+)$/.exec(absolutePath);
  if (otherMatch) {
    return `./${otherMatch[1]}`;
  }

  return absolutePath;
}

export { DEFAULT_DLP_CONFIG, shannonEntropy, convertToRelative, estimateTokens };
