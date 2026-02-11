import { describe, expect, it } from 'vitest';
import { shouldIgnore, loadIgnorePatterns } from '../../../src/config/ignore.js';

describe('shouldIgnore', () => {
  const patterns = ['node_modules', '.git', 'dist', '*.db', '.env', '.env.*'];

  it('ignores node_modules paths', () => {
    expect(shouldIgnore('src/node_modules/foo/bar.js', patterns)).toBe(true);
  });

  it('ignores .git paths', () => {
    expect(shouldIgnore('project/.git/config', patterns)).toBe(true);
  });

  it('ignores *.db files', () => {
    expect(shouldIgnore('data/codemoot.db', patterns)).toBe(true);
  });

  it('does not ignore regular source files', () => {
    expect(shouldIgnore('src/index.ts', patterns)).toBe(false);
  });

  it('does not ignore partial matches', () => {
    expect(shouldIgnore('src/distribution/file.ts', patterns)).toBe(false);
  });
});

describe('loadIgnorePatterns', () => {
  it('returns builtin patterns for non-existent dir', () => {
    const patterns = loadIgnorePatterns('/tmp/nonexistent-dir-xyz');
    expect(patterns).toContain('node_modules');
    expect(patterns).toContain('.git');
    expect(patterns).toContain('dist');
  });
});
