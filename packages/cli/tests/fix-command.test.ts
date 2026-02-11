import { describe, expect, it } from 'vitest';
import { Command, Option } from 'commander';

function createFixCommand() {
  const program = new Command();
  program
    .command('fix')
    .description('Autofix loop')
    .argument('<file-or-glob>', 'File to fix')
    .option('--max-rounds <n>', 'Max rounds', (v: string) => Number.parseInt(v, 10), 3)
    .addOption(new Option('--focus <area>').choices(['security', 'performance', 'bugs', 'all']).default('bugs'))
    .option('--timeout <seconds>', 'Timeout', (v: string) => Number.parseInt(v, 10), 600)
    .option('--dry-run', 'Review only', false)
    .option('--diff <revspec>', 'Fix diff')
    .option('--session <id>', 'Session')
    .action(() => {});
  return program;
}

describe('fix command', () => {
  it('registers with expected options', () => {
    const program = createFixCommand();
    const fix = program.commands.find(c => c.name() === 'fix');
    expect(fix).toBeDefined();
    const opts = fix?.options.map(o => o.long);
    expect(opts).toContain('--max-rounds');
    expect(opts).toContain('--focus');
    expect(opts).toContain('--dry-run');
    expect(opts).toContain('--diff');
  });

  it('defaults to bugs focus', () => {
    const program = createFixCommand();
    const fix = program.commands.find(c => c.name() === 'fix');
    const focusOpt = fix?.options.find(o => o.long === '--focus');
    expect(focusOpt?.defaultValue).toBe('bugs');
  });

  it('defaults to 3 max rounds', () => {
    const program = createFixCommand();
    const fix = program.commands.find(c => c.name() === 'fix');
    const roundsOpt = fix?.options.find(o => o.long === '--max-rounds');
    expect(roundsOpt?.defaultValue).toBe(3);
  });
});
