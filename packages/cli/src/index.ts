import { Command, InvalidArgumentError, Option } from 'commander';

import { CLEANUP_TIMEOUT_SEC, VERSION } from '@codemoot/core';

import {
  buildEventCommand,
  buildListCommand,
  buildReviewCommand,
  buildStartCommand,
  buildStatusCommand,
} from './commands/build.js';
import {
  debateCompleteCommand,
  debateHistoryCommand,
  debateListCommand,
  debateStartCommand,
  debateStatusCommand,
  debateTurnCommand,
} from './commands/debate.js';
import { cleanupCommand } from './commands/cleanup.js';
import { costCommand } from './commands/cost.js';
import { doctorCommand } from './commands/doctor.js';
import { eventsCommand } from './commands/events.js';
import { fixCommand } from './commands/fix.js';
import { initCommand } from './commands/init.js';
import { installSkillsCommand } from './commands/install-skills.js';
import {
  sessionStartCommand,
  sessionCurrentCommand,
  sessionListCommand,
  sessionStatusCommand,
  sessionCloseCommand,
} from './commands/session.js';
import {
  jobsListCommand,
  jobsLogsCommand,
  jobsCancelCommand,
  jobsRetryCommand,
  jobsStatusCommand,
} from './commands/jobs.js';
import { planCommand } from './commands/plan.js';
import { reviewCommand } from './commands/review.js';
import { runCommand } from './commands/run.js';
import { shipitCommand } from './commands/shipit.js';
import { startCommand } from './commands/start.js';
import { watchCommand } from './commands/watch.js';
import { workerCommand } from './commands/worker.js';

const program = new Command();

program
  .name('codemoot')
  .description('Multi-model collaborative AI development tool')
  .version(VERSION)
  .option('--verbose', 'Enable debug logging');

program
  .command('start')
  .description('First-run setup: verify codex, init config, run quick review')
  .action(startCommand);

program
  .command('doctor')
  .description('Preflight diagnostics: check codex, config, database, git, node')
  .action(doctorCommand);

program
  .command('install-skills')
  .description('Install Claude Code slash commands (/debate, /build, /codex-review, /cleanup)')
  .option('--force', 'Overwrite existing skill files', false)
  .action(installSkillsCommand);

program
  .command('init')
  .description('Initialize CodeMoot in the current project')
  .option('--preset <name>', 'Use preset (balanced|budget)')
  .option('--non-interactive', 'Skip prompts, use defaults')
  .option('--force', 'Overwrite existing .cowork.yml')
  .action(initCommand);

program
  .command('run')
  .description('Run a task through the full workflow')
  .argument('<task>', 'Task description (natural language)')
  .option('--mode <mode>', 'Execution mode (autonomous|interactive)', 'autonomous')
  .option('--max-iterations <n>', 'Max review loop iterations', (v: string) => Number.parseInt(v, 10), 3)
  .option('--no-stream', 'Disable streaming output')
  .action(runCommand);

program
  .command('review')
  .description('Review code via codex — files, prompts, or diffs')
  .argument('[file-or-glob]', 'File path or glob pattern to review')
  .option('--prompt <instruction>', 'Freeform prompt — codex explores codebase via tools')
  .option('--stdin', 'Read prompt from stdin')
  .option('--diff <revspec>', 'Review a git diff (e.g., HEAD~3..HEAD, origin/main...HEAD)')
  .option('--scope <glob>', 'Restrict codex exploration to matching files (only with --prompt/--stdin)')
  .addOption(new Option('--focus <area>', 'Focus area').choices(['security', 'performance', 'bugs', 'all']).default('all'))
  .option('--preset <name>', 'Use named preset (security-audit|performance|quick-scan|pre-commit|api-review)')
  .option('--session <id>', 'Use specific session (default: active session)')
  .option('--background', 'Enqueue review and return immediately')
  .option('--timeout <seconds>', 'Timeout in seconds', (v: string) => {
    if (!/^\d+$/.test(v)) throw new InvalidArgumentError('Timeout must be a positive integer');
    const n = Number.parseInt(v, 10);
    if (n <= 0) throw new InvalidArgumentError('Timeout must be a positive integer');
    return n;
  }, 600)
  .action(reviewCommand);

program
  .command('cleanup')
  .description('Scan codebase for AI slop: security vulns, anti-patterns, near-duplicates, dead code, and more')
  .argument('[path]', 'Project path to scan', '.')
  .addOption(new Option('--scope <scope>', 'What to scan for').choices(['deps', 'unused-exports', 'hardcoded', 'duplicates', 'deadcode', 'security', 'near-duplicates', 'anti-patterns', 'all']).default('all'))
  .option('--timeout <seconds>', 'Codex scan timeout in seconds', (v: string) => {
    if (!/^\d+$/.test(v)) throw new InvalidArgumentError('Timeout must be a positive integer');
    const n = Number.parseInt(v, 10);
    if (n <= 0) throw new InvalidArgumentError('Timeout must be a positive integer');
    return n;
  }, CLEANUP_TIMEOUT_SEC)
  .option('--max-disputes <n>', 'Max findings to adjudicate', (v: string) => {
    if (!/^\d+$/.test(v)) throw new InvalidArgumentError('Must be a non-negative integer');
    return Number.parseInt(v, 10);
  }, 10)
  .option('--host-findings <path>', 'JSON file with host AI findings for 3-way merge')
  .option('--output <path>', 'Write findings report to JSON file')
  .option('--background', 'Enqueue cleanup and return immediately')
  .option('--no-gitignore', 'Skip .gitignore rules (scan everything)')
  .option('--quiet', 'Suppress human-readable summary')
  .action(cleanupCommand);

program
  .command('plan')
  .description('Generate a plan using architect + reviewer loop')
  .argument('<task>', 'Task to plan')
  .option('--rounds <n>', 'Max plan-review rounds', (v: string) => Number.parseInt(v, 10), 3)
  .option('--output <file>', 'Save plan to file')
  .action(planCommand);

const debate = program
  .command('debate')
  .description('Multi-model debate with session persistence');

debate
  .command('start')
  .description('Start a new debate')
  .argument('<topic>', 'Debate topic or question')
  .option('--max-rounds <n>', 'Max debate rounds', (v: string) => Number.parseInt(v, 10), 5)
  .action(debateStartCommand);

debate
  .command('turn')
  .description('Send a prompt to GPT and get critique (with session resume)')
  .argument('<debate-id>', 'Debate ID from start command')
  .argument('<prompt>', 'Prompt to send to GPT')
  .option('--round <n>', 'Round number', (v: string) => Number.parseInt(v, 10))
  .option('--timeout <seconds>', 'Timeout in seconds', (v: string) => Number.parseInt(v, 10), 600)
  .action(debateTurnCommand);

debate
  .command('status')
  .description('Show debate status and session info')
  .argument('<debate-id>', 'Debate ID')
  .action(debateStatusCommand);

debate
  .command('list')
  .description('List all debates')
  .option('--status <status>', 'Filter by status (active|completed|stale)')
  .option('--limit <n>', 'Max results', (v: string) => Number.parseInt(v, 10), 20)
  .action(debateListCommand);

debate
  .command('history')
  .description('Show full message history with token budget')
  .argument('<debate-id>', 'Debate ID')
  .action(debateHistoryCommand);

debate
  .command('complete')
  .description('Mark a debate as completed')
  .argument('<debate-id>', 'Debate ID')
  .action(debateCompleteCommand);

const build = program
  .command('build')
  .description('Automated build loop: debate → plan → implement → review → fix');

build
  .command('start')
  .description('Start a new build session')
  .argument('<task>', 'Task description')
  .option('--max-rounds <n>', 'Max debate rounds', (v: string) => Number.parseInt(v, 10), 5)
  .option('--allow-dirty', 'Allow starting with dirty working tree (auto-stashes)')
  .action(buildStartCommand);

build
  .command('status')
  .description('Show build status and event log')
  .argument('<build-id>', 'Build ID')
  .action(buildStatusCommand);

build
  .command('list')
  .description('List all builds')
  .option('--status <status>', 'Filter by status')
  .option('--limit <n>', 'Max results', (v: string) => Number.parseInt(v, 10), 20)
  .action(buildListCommand);

build
  .command('event')
  .description('Record a build event (phase transition)')
  .argument('<build-id>', 'Build ID')
  .argument('<event-type>', 'Event type (plan_approved|impl_completed|fix_completed|etc)')
  .option('--loop <n>', 'Loop index', (v: string) => Number.parseInt(v, 10))
  .option('--tokens <n>', 'Tokens used', (v: string) => Number.parseInt(v, 10))
  .action(buildEventCommand);

build
  .command('review')
  .description('Send implementation to codex for review (with codebase access)')
  .argument('<build-id>', 'Build ID')
  .action(buildReviewCommand);

const session = program
  .command('session')
  .description('Unified session management — persistent GPT context across commands');

session
  .command('start')
  .description('Start a new session')
  .option('--name <name>', 'Session name')
  .action(sessionStartCommand);

session
  .command('current')
  .description('Show the active session')
  .action(sessionCurrentCommand);

session
  .command('list')
  .description('List all sessions')
  .option('--status <status>', 'Filter by status (active|completed|stale)')
  .option('--limit <n>', 'Max results', (v: string) => Number.parseInt(v, 10), 20)
  .action(sessionListCommand);

session
  .command('status')
  .description('Show detailed session info with events')
  .argument('<session-id>', 'Session ID')
  .action(sessionStatusCommand);

session
  .command('close')
  .description('Mark a session as completed')
  .argument('<session-id>', 'Session ID')
  .action(sessionCloseCommand);

// ── Jobs (background async queue) ──

const jobs = program
  .command('jobs')
  .description('Background job queue — async reviews, cleanups, and more');

jobs
  .command('list')
  .description('List jobs')
  .option('--status <status>', 'Filter by status (queued|running|succeeded|failed|canceled)')
  .option('--type <type>', 'Filter by type (review|cleanup|build-review|composite|watch-review)')
  .option('--limit <n>', 'Max results', (v: string) => Number.parseInt(v, 10), 20)
  .action(jobsListCommand);

jobs
  .command('status')
  .description('Show job details with recent logs')
  .argument('<job-id>', 'Job ID')
  .action(jobsStatusCommand);

jobs
  .command('logs')
  .description('Show job logs')
  .argument('<job-id>', 'Job ID')
  .option('--from-seq <n>', 'Start from log sequence number', (v: string) => Number.parseInt(v, 10), 0)
  .option('--limit <n>', 'Max log entries', (v: string) => Number.parseInt(v, 10), 100)
  .action(jobsLogsCommand);

jobs
  .command('cancel')
  .description('Cancel a queued or running job')
  .argument('<job-id>', 'Job ID')
  .action(jobsCancelCommand);

jobs
  .command('retry')
  .description('Retry a failed job')
  .argument('<job-id>', 'Job ID')
  .action(jobsRetryCommand);

// ── Fix (autofix loop: review → fix → re-review) ──

program
  .command('fix')
  .description('Autofix loop: review code, apply fixes, re-review until approved')
  .argument('<file-or-glob>', 'File path or glob pattern to fix')
  .option('--max-rounds <n>', 'Max review-fix rounds', (v: string) => Number.parseInt(v, 10), 3)
  .addOption(new Option('--focus <area>', 'Focus area').choices(['security', 'performance', 'bugs', 'all']).default('bugs'))
  .option('--timeout <seconds>', 'Timeout per round', (v: string) => Number.parseInt(v, 10), 600)
  .option('--dry-run', 'Review only, do not apply fixes', false)
  .option('--diff <revspec>', 'Fix issues in a git diff')
  .option('--session <id>', 'Use specific session')
  .action(fixCommand);

// ── Shipit (composite workflow profiles) ──

program
  .command('shipit')
  .description('Run composite workflow: lint → test → review → cleanup → commit')
  .addOption(new Option('--profile <profile>', 'Workflow profile').choices(['fast', 'safe', 'full']).default('safe'))
  .option('--dry-run', 'Print planned steps without executing', false)
  .option('--no-commit', 'Run checks but skip commit step')
  .option('--json', 'Machine-readable JSON output', false)
  .option('--strict-output', 'Strict model output parsing', false)
  .action(shipitCommand);

// ── Cost dashboard ──

program
  .command('cost')
  .description('Token usage and cost dashboard')
  .addOption(new Option('--scope <scope>', 'Time scope').choices(['session', 'daily', 'all']).default('daily'))
  .option('--days <n>', 'Number of days for daily scope', (v: string) => Number.parseInt(v, 10), 30)
  .option('--session <id>', 'Session ID for session scope')
  .action(costCommand);

// ── Watch (file change → background review) ──

program
  .command('watch')
  .description('Watch files and enqueue reviews on change')
  .option('--glob <pattern>', 'Glob pattern to watch', '**/*.{ts,tsx,js,jsx}')
  .addOption(new Option('--focus <area>', 'Focus area').choices(['security', 'performance', 'bugs', 'all']).default('all'))
  .option('--timeout <seconds>', 'Review timeout', (v: string) => Number.parseInt(v, 10), 600)
  .option('--quiet-ms <ms>', 'Quiet period before flush', (v: string) => Number.parseInt(v, 10), 800)
  .option('--max-wait-ms <ms>', 'Max wait before forced flush', (v: string) => Number.parseInt(v, 10), 5000)
  .option('--cooldown-ms <ms>', 'Cooldown after flush', (v: string) => Number.parseInt(v, 10), 1500)
  .action(watchCommand);

// ── Events (tail logs as JSONL) ──

program
  .command('events')
  .description('Stream session events and job logs as JSONL')
  .option('--follow', 'Follow mode — poll for new events', false)
  .option('--since-seq <n>', 'Start from sequence number', (v: string) => Number.parseInt(v, 10), 0)
  .option('--limit <n>', 'Max events per poll', (v: string) => Number.parseInt(v, 10), 100)
  .addOption(new Option('--type <type>', 'Event source filter').choices(['all', 'sessions', 'jobs']).default('all'))
  .action(eventsCommand);

// ── Worker (background job processor) ──

jobs
  .command('worker')
  .description('Start background job worker (processes queued jobs)')
  .option('--once', 'Process one job and exit', false)
  .option('--poll-ms <ms>', 'Poll interval in milliseconds', (v: string) => Number.parseInt(v, 10), 2000)
  .option('--worker-id <id>', 'Worker identifier', `w-${Date.now()}`)
  .action(workerCommand);

program.parse();

export { program };
