import { describe, expect, it } from 'vitest';
import { Command, Option } from 'commander';

function createShipitCommand() {
  const program = new Command();
  program
    .command('shipit')
    .description('Run composite workflow')
    .addOption(new Option('--profile <profile>').choices(['fast', 'safe', 'full']).default('safe'))
    .option('--dry-run', 'Dry run', false)
    .option('--no-commit', 'Skip commit')
    .option('--json', 'JSON output', false)
    .action(() => {});
  return program;
}

describe('shipit command', () => {
  it('registers with profile choices', () => {
    const program = createShipitCommand();
    const shipit = program.commands.find(c => c.name() === 'shipit');
    expect(shipit).toBeDefined();
    const opts = shipit?.options.map(o => o.long);
    expect(opts).toContain('--profile');
    expect(opts).toContain('--dry-run');
    expect(opts).toContain('--json');
  });

  it('defaults to safe profile', () => {
    const program = createShipitCommand();
    const shipit = program.commands.find(c => c.name() === 'shipit');
    const profileOpt = shipit?.options.find(o => o.long === '--profile');
    expect(profileOpt?.defaultValue).toBe('safe');
  });
});
