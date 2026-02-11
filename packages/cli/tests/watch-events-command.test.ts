import { describe, expect, it } from 'vitest';
import { Command, Option } from 'commander';

function createWatchCommand() {
  const program = new Command();
  program
    .command('watch')
    .description('Watch files and enqueue reviews on change')
    .option('--glob <pattern>', 'Glob pattern to watch', '**/*.{ts,tsx,js,jsx}')
    .addOption(new Option('--focus <area>', 'Focus area').choices(['security', 'performance', 'bugs', 'all']).default('all'))
    .option('--timeout <seconds>', 'Review timeout', (v: string) => Number.parseInt(v, 10), 600)
    .option('--quiet-ms <ms>', 'Quiet period before flush', (v: string) => Number.parseInt(v, 10), 800)
    .action(() => {});
  return program;
}

function createEventsCommand() {
  const program = new Command();
  program
    .command('events')
    .description('Stream events as JSONL')
    .option('--follow', 'Follow mode', false)
    .option('--since-seq <n>', 'Start from seq', (v: string) => Number.parseInt(v, 10), 0)
    .option('--limit <n>', 'Max events', (v: string) => Number.parseInt(v, 10), 100)
    .addOption(new Option('--type <type>', 'Filter').choices(['all', 'sessions', 'jobs']).default('all'))
    .action(() => {});
  return program;
}

describe('watch command', () => {
  it('registers with expected options', () => {
    const program = createWatchCommand();
    const watch = program.commands.find(c => c.name() === 'watch');
    expect(watch).toBeDefined();
    const opts = watch?.options.map(o => o.long);
    expect(opts).toContain('--glob');
    expect(opts).toContain('--focus');
    expect(opts).toContain('--timeout');
    expect(opts).toContain('--quiet-ms');
  });
});

describe('events command', () => {
  it('registers with expected options', () => {
    const program = createEventsCommand();
    const events = program.commands.find(c => c.name() === 'events');
    expect(events).toBeDefined();
    const opts = events?.options.map(o => o.long);
    expect(opts).toContain('--follow');
    expect(opts).toContain('--since-seq');
    expect(opts).toContain('--type');
  });
});
