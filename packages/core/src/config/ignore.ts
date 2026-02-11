// packages/core/src/config/ignore.ts — .gitignore + .codemootignore aware file filtering

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';

const BUILTIN_IGNORES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'release',
  'out',
  '.cowork',
  '.cache',
  '.turbo',
  '.next',
  '__pycache__',
  'vendor',
  'coverage',
  '*.db',
  '*.db-journal',
  '*.db-wal',
  '*.db-shm',
  '.env',
  '.env.*',
];

/**
 * Load and compile all ignore patterns into a single matcher.
 * Precedence: builtins -> .gitignore -> .codemootignore
 */
export function createIgnoreFilter(projectDir: string, options?: { skipGitignore?: boolean }): Ignore {
  const ig = ignore();

  // 1. Builtins
  ig.add(BUILTIN_IGNORES);

  // 2. .gitignore (root only for now)
  if (!options?.skipGitignore) {
    const gitignorePath = join(projectDir, '.gitignore');
    if (existsSync(gitignorePath)) {
      const content = readFileSync(gitignorePath, 'utf-8');
      ig.add(content);
    }
  }

  // 3. .codemootignore (highest priority — can override builtins/.gitignore)
  const codemootIgnorePath = join(projectDir, '.codemootignore');
  if (existsSync(codemootIgnorePath)) {
    const content = readFileSync(codemootIgnorePath, 'utf-8');
    ig.add(content);
  }

  return ig;
}

// ── Legacy API (kept for existing tests) ──

export function loadIgnorePatterns(projectDir: string): string[] {
  const patterns = [...BUILTIN_IGNORES];
  const ignorePath = join(projectDir, '.codemootignore');
  if (existsSync(ignorePath)) {
    const content = readFileSync(ignorePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        patterns.push(trimmed);
      }
    }
  }
  return patterns;
}

export function shouldIgnore(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    if (
      normalized.includes(`/${pattern}/`) ||
      normalized.endsWith(`/${pattern}`) ||
      normalized === pattern
    ) {
      return true;
    }
    if (pattern.startsWith('*.') && normalized.endsWith(pattern.slice(1))) {
      return true;
    }
  }
  return false;
}
