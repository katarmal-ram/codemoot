import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DLP_CONFIG,
  convertToRelative,
  estimateTokens,
  sanitize,
  shannonEntropy,
} from '../../../src/security/dlp.js';
import { DlpReasonCode } from '../../../src/types/mcp.js';

describe('sanitize', () => {
  it('returns empty result for empty input', () => {
    const result = sanitize('');
    expect(result.sanitized).toBe('');
    expect(result.redactions).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(result.auditLog).toHaveLength(0);
  });

  it('passes normal code content through unchanged', () => {
    const code = 'function hello() {\n  console.log("world");\n}';
    const result = sanitize(code);
    expect(result.sanitized).toBe(code);
    expect(result.redactions).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  // Stage 1: Secret detection
  it('detects and redacts AWS access key', () => {
    const input = 'aws_key = AKIAIOSFODNN7EXAMPLE';
    const result = sanitize(input);
    expect(result.sanitized).toContain('[REDACTED:AWS_KEY]');
    expect(result.sanitized).not.toContain('AKIAIOSFODNN7EXAMPLE');
    const redaction = result.redactions.find((r) => r.replacement === '[REDACTED:AWS_KEY]');
    expect(redaction).toBeDefined();
    expect(redaction?.stage).toBe(1);
    expect(redaction?.reasonCode).toBe(DlpReasonCode.SECRET_DETECTED);
  });

  it('detects and redacts OpenAI API key (sk-xxx)', () => {
    const input = 'key = sk-abc123def456ghi789jkl012mno345';
    const result = sanitize(input);
    expect(result.sanitized).toContain('[REDACTED:API_KEY]');
    expect(result.sanitized).not.toContain('sk-abc123def456ghi789jkl012mno345');
  });

  it('detects and redacts sk-proj-xxx key', () => {
    const input = 'key = sk-proj-abc123def456ghi789jkl012mno345';
    const result = sanitize(input);
    expect(result.sanitized).toContain('[REDACTED:API_KEY]');
    expect(result.sanitized).not.toContain('sk-proj-abc123def456ghi789jkl012mno345');
  });

  it('detects and redacts GitHub token', () => {
    const input = 'token = ghp_ABCDEFghijklmnopqrstuvwxyz0123456789';
    const result = sanitize(input);
    expect(result.sanitized).toContain('[REDACTED:GITHUB_TOKEN]');
    expect(result.sanitized).not.toContain('ghp_ABCDEFghijklmnopqrstuvwxyz0123456789');
  });

  it('detects and redacts JWT', () => {
    const input = 'auth = eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const result = sanitize(input);
    expect(result.sanitized).toContain('[REDACTED:JWT]');
    expect(result.sanitized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('detects and redacts private key header', () => {
    const input = 'cert:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAI...';
    const result = sanitize(input);
    expect(result.sanitized).toContain('[REDACTED:PRIVATE_KEY]');
    expect(result.sanitized).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('detects and redacts Bearer token', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test.sig';
    const result = sanitize(input);
    // Bearer token pattern or JWT pattern may match — either way the sensitive content is redacted
    const hasRedaction = result.redactions.some(
      (r) => r.replacement === '[REDACTED:BEARER_TOKEN]' || r.replacement === '[REDACTED:JWT]',
    );
    expect(hasRedaction).toBe(true);
  });

  it('detects and redacts connection string credentials', () => {
    const input = 'db = postgres://admin:secretpassword@db.example.com:5432/mydb';
    const result = sanitize(input);
    expect(result.sanitized).toContain('[REDACTED:CONNECTION_STRING]');
    expect(result.sanitized).not.toContain('admin:secretpassword@');
  });

  it('redacts multiple secrets in same input', () => {
    const input = 'aws = AKIAIOSFODNN7EXAMPLE\ntoken = ghp_ABCDEFghijklmnopqrstuvwxyz0123456789';
    const result = sanitize(input);
    expect(result.sanitized).toContain('[REDACTED:AWS_KEY]');
    expect(result.sanitized).toContain('[REDACTED:GITHUB_TOKEN]');
    expect(result.redactions.length).toBeGreaterThanOrEqual(2);
  });

  // Stage 2: Entropy check
  it('redacts high entropy string in strict mode', () => {
    // Create a high-entropy string (random-looking, > 20 chars)
    const highEntropy = 'aZ9$kL2@mN4#pQ6^rS8&tU0!vX3*yB5';
    const input = `secret: ${highEntropy}`;
    const result = sanitize(input, { mode: 'strict' });
    // The high-entropy token should be redacted
    const entropyRedaction = result.redactions.find(
      (r) => r.reasonCode === DlpReasonCode.HIGH_ENTROPY,
    );
    expect(entropyRedaction).toBeDefined();
    expect(result.sanitized).toContain('[REDACTED:HIGH_ENTROPY]');
  });

  it('does NOT redact high entropy string in open mode', () => {
    const highEntropy = 'aZ9$kL2@mN4#pQ6^rS8&tU0!vX3*yB5';
    const input = `data: ${highEntropy}`;
    const result = sanitize(input, { mode: 'open' });
    // Should NOT have any HIGH_ENTROPY redaction
    const entropyRedaction = result.redactions.find(
      (r) => r.reasonCode === DlpReasonCode.HIGH_ENTROPY,
    );
    expect(entropyRedaction).toBeUndefined();
  });

  // Stage 3: Path conversion
  it('converts absolute Windows path to relative', () => {
    const input = 'file at C:\\Users\\john\\project\\src\\index.ts';
    const result = sanitize(input);
    expect(result.sanitized).not.toContain('C:\\Users\\john');
    const pathRedaction = result.redactions.find(
      (r) => r.reasonCode === DlpReasonCode.ABSOLUTE_PATH,
    );
    expect(pathRedaction).toBeDefined();
    expect(result.sanitized).toContain('./');
  });

  it('converts absolute Unix path to relative', () => {
    const input = 'file at /home/user/project/src/index.ts';
    const result = sanitize(input);
    expect(result.sanitized).not.toContain('/home/user');
    const pathRedaction = result.redactions.find(
      (r) => r.reasonCode === DlpReasonCode.ABSOLUTE_PATH,
    );
    expect(pathRedaction).toBeDefined();
    expect(result.sanitized).toContain('./');
  });

  it('converts /Users/ Mac path to relative', () => {
    const input = 'path: /Users/developer/workspace/app.js';
    const result = sanitize(input);
    expect(result.sanitized).not.toContain('/Users/developer');
    expect(result.sanitized).toContain('./');
  });

  // Stage 4: Context truncation
  it('truncates when exceeding token limit', () => {
    // Create input that exceeds token limit. maxTokens=100, char/4 heuristic means 400 chars.
    // Use short words separated by spaces to avoid base64/entropy detection.
    const words = [];
    for (let i = 0; i < 200; i++) {
      words.push(`word${String(i)}`);
    }
    const longInput = words.join(' ');
    const result = sanitize(longInput, { maxTokens: 100 });
    expect(result.truncated).toBe(true);
    expect(result.sanitized).toContain('[TRUNCATED: context exceeded token limit]');
    const truncRedaction = result.redactions.find(
      (r) => r.reasonCode === DlpReasonCode.CONTEXT_TRUNCATED,
    );
    expect(truncRedaction).toBeDefined();
  });

  it('does NOT truncate when within token limit', () => {
    const input = 'short input';
    const result = sanitize(input, { maxTokens: 100 });
    expect(result.truncated).toBe(false);
    expect(result.sanitized).toBe('short input');
  });

  // Stage 5: Audit log
  it('creates audit log entries for each stage', () => {
    const input = 'simple code content';
    const result = sanitize(input);
    // Should have entries for decode check, secret scan, entropy scan, path scan, context check, complete
    expect(result.auditLog.length).toBeGreaterThanOrEqual(5);
    const stages = result.auditLog.map((entry) => entry.stage);
    expect(stages).toContain(0);
    expect(stages).toContain(1);
    expect(stages).toContain(2);
    expect(stages).toContain(3);
    expect(stages).toContain(4);
    expect(stages).toContain(5);
  });

  it('audit entries contain timestamps', () => {
    const result = sanitize('test content');
    for (const entry of result.auditLog) {
      expect(entry.timestamp).toBeDefined();
      // Should be valid ISO date
      expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
    }
  });

  // Budget enforcement
  it('rejects input exceeding maxInputBytes', () => {
    // Default 5MB, use a smaller limit for test
    const largeInput = 'x'.repeat(1000);
    const result = sanitize(largeInput, { maxInputBytes: 500 });
    expect(result.sanitized).toBe('[BLOCKED: input exceeds size budget]');
    expect(result.truncated).toBe(true);
    const budgetRedaction = result.redactions.find(
      (r) => r.reasonCode === DlpReasonCode.BUDGET_EXCEEDED,
    );
    expect(budgetRedaction).toBeDefined();
  });

  // Mode differences
  it('open mode skips secret and entropy stages', () => {
    const input = 'key = sk-abc123def456ghi789jkl012mno345';
    const result = sanitize(input, { mode: 'open' });
    // In open mode, secrets are NOT redacted
    const secretRedaction = result.redactions.find(
      (r) => r.reasonCode === DlpReasonCode.SECRET_DETECTED,
    );
    expect(secretRedaction).toBeUndefined();
    // Audit log should show skipped stages
    const skippedEntries = result.auditLog.filter((e) => e.action === 'SKIPPED');
    expect(skippedEntries.length).toBe(2); // Stage 1 and 2 skipped
  });

  it('strict mode redacts secrets that open mode does not', () => {
    const input = 'key = sk-abc123def456ghi789jkl012mno345';
    const strict = sanitize(input, { mode: 'strict' });
    const open = sanitize(input, { mode: 'open' });

    expect(strict.sanitized).toContain('[REDACTED:API_KEY]');
    expect(open.sanitized).not.toContain('[REDACTED:API_KEY]');
    expect(open.sanitized).toContain('sk-abc123def456ghi789jkl012mno345');
  });

  // Stage 0: Encoded content
  it('flags large base64 blocks', () => {
    // Create a base64-like string > 64 chars
    const base64Block =
      'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB';
    const input = `encoded: ${base64Block}`;
    const result = sanitize(input);
    const decodeRedaction = result.redactions.find(
      (r) => r.reasonCode === DlpReasonCode.DECODE_BLOCKED,
    );
    expect(decodeRedaction).toBeDefined();
    expect(result.sanitized).toContain('[REDACTED:ENCODED_CONTENT]');
  });
});

describe('shannonEntropy', () => {
  it('returns 0 for empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('returns 0 for single repeated character', () => {
    expect(shannonEntropy('aaaaaaa')).toBe(0);
  });

  it('returns 1 for two equally distributed characters', () => {
    const entropy = shannonEntropy('abababab');
    expect(entropy).toBeCloseTo(1.0, 1);
  });

  it('returns higher entropy for more diverse characters', () => {
    const low = shannonEntropy('aabb');
    const high = shannonEntropy('abcd');
    expect(high).toBeGreaterThan(low);
  });
});

describe('convertToRelative', () => {
  it('converts Windows path with Users', () => {
    const result = convertToRelative('C:\\Users\\john\\project\\file.ts');
    expect(result).toBe('./project/file.ts');
  });

  it('converts Unix /home/ path', () => {
    const result = convertToRelative('/home/user/project/file.ts');
    expect(result).toBe('./project/file.ts');
  });

  it('converts /Users/ Mac path', () => {
    const result = convertToRelative('/Users/dev/workspace/app.js');
    expect(result).toBe('./workspace/app.js');
  });

  it('converts /var/ path', () => {
    const result = convertToRelative('/var/log/app.log');
    expect(result).toBe('./log/app.log');
  });

  it('returns original for non-matching path', () => {
    const result = convertToRelative('relative/path/file.ts');
    expect(result).toBe('relative/path/file.ts');
  });
});

describe('estimateTokens', () => {
  it('estimates tokens as char count / 4', () => {
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });

  it('rounds up for non-divisible lengths', () => {
    expect(estimateTokens('abc')).toBe(1); // ceil(3/4) = 1
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('DEFAULT_DLP_CONFIG', () => {
  it('has expected defaults', () => {
    expect(DEFAULT_DLP_CONFIG.mode).toBe('strict');
    expect(DEFAULT_DLP_CONFIG.maxInputBytes).toBe(5 * 1024 * 1024);
    expect(DEFAULT_DLP_CONFIG.maxProcessingMs).toBe(2000);
    expect(DEFAULT_DLP_CONFIG.maxRegexOps).toBe(1000);
    expect(DEFAULT_DLP_CONFIG.maxTokens).toBe(32_000);
  });
});
