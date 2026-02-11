// tests/review-command.test.ts — CLI review command registration tests

import { describe, it, expect } from 'vitest';
import { Command, Option } from 'commander';

/** Helper to create a review command matching the real CLI registration. */
function createReviewCommand(actionFn: (...args: unknown[]) => void = () => {}) {
  const program = new Command();
  program.exitOverride();

  program
    .command('review')
    .description('Review code via codex — files, prompts, or diffs')
    .argument('[file-or-glob]', 'File path or glob pattern to review')
    .option('--prompt <instruction>', 'Freeform prompt — codex explores codebase via tools')
    .option('--stdin', 'Read prompt from stdin')
    .option('--diff <revspec>', 'Review a git diff')
    .option('--scope <glob>', 'Restrict exploration scope (only with --prompt/--stdin)')
    .addOption(new Option('--focus <area>', 'Focus area').choices(['security', 'performance', 'bugs', 'all']).default('all'))
    .option('--timeout <seconds>', 'Timeout in seconds', (v: string) => {
      if (!/^\d+$/.test(v)) throw new Error('Timeout must be a positive integer');
      const n = Number.parseInt(v, 10);
      if (n <= 0) throw new Error('Timeout must be a positive integer');
      return n;
    }, 600)
    .action(actionFn);

  return program;
}

describe('review command registration', () => {
  it('registers review command', () => {
    const program = createReviewCommand();
    const found = program.commands.find(c => c.name() === 'review');
    expect(found).toBeDefined();
  });

  it('accepts file argument', () => {
    let capturedFile: string | undefined;
    const program = createReviewCommand((file, _opts) => { capturedFile = file as string; });
    program.parse(['node', 'test', 'review', 'src/foo.ts']);
    expect(capturedFile).toBe('src/foo.ts');
  });

  it('accepts --prompt without file argument', () => {
    let capturedFile: string | undefined;
    let capturedOpts: Record<string, unknown> = {};
    const program = createReviewCommand((file, opts) => {
      capturedFile = file as string;
      capturedOpts = opts as Record<string, unknown>;
    });
    program.parse(['node', 'test', 'review', '--prompt', 'check for race conditions']);
    expect(capturedFile).toBeUndefined();
    expect(capturedOpts.prompt).toBe('check for race conditions');
  });

  it('accepts --diff without file argument', () => {
    let capturedOpts: Record<string, unknown> = {};
    const program = createReviewCommand((_file, opts) => {
      capturedOpts = opts as Record<string, unknown>;
    });
    program.parse(['node', 'test', 'review', '--diff', 'HEAD~3..HEAD']);
    expect(capturedOpts.diff).toBe('HEAD~3..HEAD');
  });

  it('accepts --scope with --prompt', () => {
    let capturedOpts: Record<string, unknown> = {};
    const program = createReviewCommand((_file, opts) => {
      capturedOpts = opts as Record<string, unknown>;
    });
    program.parse(['node', 'test', 'review', '--prompt', 'check auth', '--scope', 'packages/**']);
    expect(capturedOpts.prompt).toBe('check auth');
    expect(capturedOpts.scope).toBe('packages/**');
  });

  it('rejects invalid focus values', () => {
    const program = createReviewCommand();
    expect(() => {
      program.parse(['node', 'test', 'review', 'file.ts', '--focus', 'invalid']);
    }).toThrow();
  });

  it('rejects non-numeric timeout', () => {
    const program = createReviewCommand();
    expect(() => {
      program.parse(['node', 'test', 'review', 'file.ts', '--timeout', 'abc']);
    }).toThrow();
  });

  it('rejects zero timeout', () => {
    const program = createReviewCommand();
    expect(() => {
      program.parse(['node', 'test', 'review', 'file.ts', '--timeout', '0']);
    }).toThrow();
  });

  it('accepts valid focus values', () => {
    for (const focus of ['security', 'performance', 'bugs', 'all']) {
      let capturedOpts: Record<string, unknown> = {};
      const program = createReviewCommand((_file, opts) => { capturedOpts = opts as Record<string, unknown>; });
      program.parse(['node', 'test', 'review', 'file.ts', '--focus', focus]);
      expect(capturedOpts.focus).toBe(focus);
    }
  });

  it('accepts valid timeout', () => {
    let capturedOpts: Record<string, unknown> = {};
    const program = createReviewCommand((_file, opts) => { capturedOpts = opts as Record<string, unknown>; });
    program.parse(['node', 'test', 'review', 'file.ts', '--timeout', '300']);
    expect(capturedOpts.timeout).toBe(300);
  });
});
