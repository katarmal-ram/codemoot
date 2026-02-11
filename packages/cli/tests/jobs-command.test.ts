import { describe, expect, it } from 'vitest';
import { Command } from 'commander';

function createJobsCommand() {
  const program = new Command();
  const jobs = program.command('jobs').description('Background job queue');

  jobs.command('list')
    .option('--status <status>', 'Filter by status')
    .option('--type <type>', 'Filter by type')
    .option('--limit <n>', 'Max results', (v: string) => Number.parseInt(v, 10), 20)
    .action(() => {});

  jobs.command('status').argument('<job-id>').action(() => {});
  jobs.command('logs').argument('<job-id>')
    .option('--from-seq <n>', '', (v: string) => Number.parseInt(v, 10), 0)
    .action(() => {});
  jobs.command('cancel').argument('<job-id>').action(() => {});
  jobs.command('retry').argument('<job-id>').action(() => {});

  return program;
}

describe('jobs command', () => {
  it('registers list subcommand with filters', () => {
    const program = createJobsCommand();
    const jobs = program.commands.find(c => c.name() === 'jobs');
    expect(jobs).toBeDefined();
    const list = jobs?.commands.find(c => c.name() === 'list');
    expect(list).toBeDefined();
    const options = list?.options.map(o => o.long);
    expect(options).toContain('--status');
    expect(options).toContain('--type');
    expect(options).toContain('--limit');
  });

  it('registers status subcommand', () => {
    const program = createJobsCommand();
    const jobs = program.commands.find(c => c.name() === 'jobs');
    const status = jobs?.commands.find(c => c.name() === 'status');
    expect(status).toBeDefined();
  });

  it('registers cancel and retry subcommands', () => {
    const program = createJobsCommand();
    const jobs = program.commands.find(c => c.name() === 'jobs');
    expect(jobs?.commands.find(c => c.name() === 'cancel')).toBeDefined();
    expect(jobs?.commands.find(c => c.name() === 'retry')).toBeDefined();
  });
});
