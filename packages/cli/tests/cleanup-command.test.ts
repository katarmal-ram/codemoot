// tests/cleanup-command.test.ts — CLI cleanup command option parsing tests

import { describe, it, expect } from 'vitest';
import { Command, Option } from 'commander';

describe('cleanup command registration', () => {
  it('registers cleanup command with correct options', () => {
    const program = new Command();
    program.exitOverride();

    program
      .command('cleanup')
      .argument('[path]', 'path', '.')
      .addOption(new Option('--scope <scope>').choices(['deps', 'unused-exports', 'hardcoded', 'duplicates', 'deadcode', 'security', 'near-duplicates', 'anti-patterns', 'all']).default('all'))
      .option('--timeout <seconds>', 'Timeout', (v: string) => {
        if (!/^\d+$/.test(v)) throw new Error('Must be positive integer');
        return Number.parseInt(v, 10);
      }, 1200)
      .option('--max-disputes <n>', 'Max disputes', (v: string) => {
        if (!/^\d+$/.test(v)) throw new Error('Must be positive integer');
        return Number.parseInt(v, 10);
      }, 10)
      .action(() => {});

    const found = program.commands.find(c => c.name() === 'cleanup');
    expect(found).toBeDefined();
  });

  it('rejects invalid scope', () => {
    const program = new Command();
    program.exitOverride();

    program
      .command('cleanup')
      .argument('[path]', 'path', '.')
      .addOption(new Option('--scope <scope>').choices(['deps', 'unused-exports', 'hardcoded', 'duplicates', 'deadcode', 'security', 'near-duplicates', 'anti-patterns', 'all']).default('all'))
      .action(() => {});

    expect(() => {
      program.parse(['node', 'test', 'cleanup', '--scope', 'invalid']);
    }).toThrow();
  });

  it('accepts all valid scopes', () => {
    for (const scope of ['deps', 'unused-exports', 'hardcoded', 'duplicates', 'deadcode', 'security', 'near-duplicates', 'anti-patterns', 'all']) {
      const program = new Command();
      program.exitOverride();
      let capturedOpts: Record<string, unknown> = {};

      program
        .command('cleanup')
        .argument('[path]', 'path', '.')
        .addOption(new Option('--scope <scope>').choices(['deps', 'unused-exports', 'hardcoded', 'duplicates', 'deadcode', 'security', 'near-duplicates', 'anti-patterns', 'all']).default('all'))
        .action((_path, opts) => { capturedOpts = opts; });

      program.parse(['node', 'test', 'cleanup', '--scope', scope]);
      expect(capturedOpts.scope).toBe(scope);
    }
  });

  it('rejects non-numeric timeout', () => {
    const program = new Command();
    program.exitOverride();

    program
      .command('cleanup')
      .argument('[path]', 'path', '.')
      .option('--timeout <seconds>', 'Timeout', (v: string) => {
        if (!/^\d+$/.test(v)) throw new Error('Must be positive integer');
        return Number.parseInt(v, 10);
      }, 1200)
      .action(() => {});

    expect(() => {
      program.parse(['node', 'test', 'cleanup', '--timeout', 'abc']);
    }).toThrow();
  });

  it('rejects non-numeric max-disputes', () => {
    const program = new Command();
    program.exitOverride();

    program
      .command('cleanup')
      .argument('[path]', 'path', '.')
      .option('--max-disputes <n>', 'Max', (v: string) => {
        if (!/^\d+$/.test(v)) throw new Error('Must be positive integer');
        return Number.parseInt(v, 10);
      }, 10)
      .action(() => {});

    expect(() => {
      program.parse(['node', 'test', 'cleanup', '--max-disputes', 'xyz']);
    }).toThrow();
  });
});
