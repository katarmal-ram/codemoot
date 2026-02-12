// packages/cli/src/commands/review.ts — unified review via codex: files, prompts, diffs + session continuity

import { loadConfig, ModelRegistry, BINARY_SNIFF_BYTES, REVIEW_DIFF_MAX_CHARS, SessionManager, JobStore, openDatabase, buildHandoffEnvelope, getReviewPreset, type CliAdapter } from '@codemoot/core';
import chalk from 'chalk';
import { execFileSync, execSync } from 'node:child_process';
import { closeSync, globSync, openSync, readFileSync, readSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { createProgressCallbacks } from '../progress.js';
import { getDbPath } from '../utils.js';

const MAX_FILE_SIZE = 100 * 1024; // 100KB per file
const MAX_TOTAL_SIZE = 200 * 1024; // 200KB total content

interface ReviewOptions {
  focus?: string;
  timeout?: number;
  session?: string;
  prompt?: string;
  stdin?: boolean;
  diff?: string;
  scope?: string;
  preset?: string;
  background?: boolean;
}

export async function reviewCommand(fileOrGlob: string | undefined, options: ReviewOptions): Promise<void> {
  try {
    const projectDir = process.cwd();

    // ── Validate input modes: exactly one of file-or-glob, --prompt, --stdin, --diff ──
    const modes = [
      fileOrGlob ? 'file' : '',
      options.prompt ? 'prompt' : '',
      options.stdin ? 'stdin' : '',
      options.diff ? 'diff' : '',
    ].filter(Boolean);

    if (modes.length === 0) {
      console.error(chalk.red('No input specified. Use: <file-or-glob>, --prompt, --stdin, or --diff'));
      process.exit(1);
    }
    if (modes.length > 1) {
      console.error(chalk.red(`Conflicting input modes: ${modes.join(', ')}. Use exactly one.`));
      process.exit(1);
    }

    if (options.scope && !options.prompt && !options.stdin) {
      console.error(chalk.red('--scope can only be used with --prompt or --stdin'));
      process.exit(1);
    }

    const config = loadConfig();
    const registry = ModelRegistry.fromConfig(config, projectDir);
    const adapter = registry.tryGetAdapter('codex-reviewer') ?? registry.tryGetAdapter('codex-architect');

    if (!adapter) {
      // Check if codex CLI is actually installed
      try {
        execSync('codex --version', { stdio: 'pipe', encoding: 'utf-8' });
      } catch {
        console.error(chalk.red('Codex CLI is not installed or not in PATH.'));
        console.error(chalk.yellow('Install it: npm install -g @openai/codex'));
        console.error(chalk.yellow('Then run: codemoot init'));
        process.exit(1);
      }
      console.error(chalk.red('No codex adapter found in config. Run: codemoot init'));
      console.error(chalk.dim('Diagnose: codemoot doctor'));
      process.exit(1);
    }

    // ── Background mode: enqueue and return immediately ──
    if (options.background) {
      const db = openDatabase(getDbPath());
      const jobStore = new JobStore(db);
      const jobId = jobStore.enqueue({
        type: 'review',
        payload: {
          fileOrGlob: fileOrGlob ?? null,
          focus: options.focus,
          timeout: options.timeout,
          prompt: options.prompt,
          stdin: options.stdin,
          diff: options.diff,
          scope: options.scope,
          cwd: projectDir,
        },
      });
      console.log(JSON.stringify({ jobId, status: 'queued', message: 'Review enqueued. Check with: codemoot jobs status ' + jobId }));
      db.close();
      return;
    }

    // Resolve unified session
    const db = openDatabase(getDbPath());
    const sessionMgr = new SessionManager(db);
    const session = options.session
      ? sessionMgr.get(options.session)
      : sessionMgr.resolveActive('review');

    if (!session) {
      console.error(chalk.red(options.session
        ? `Session not found: ${options.session}`
        : 'No active session. Run: codemoot init'));
      db.close();
      process.exit(1);
    }

    // Check overflow — auto-rollover if needed
    const overflowCheck = sessionMgr.preCallOverflowCheck(session.id);
    if (overflowCheck.rolled) {
      console.error(chalk.yellow(`  ${overflowCheck.message}`));
    }

    // ── Resolve preset (overrides focus/timeout if set) ──
    const preset = options.preset ? getReviewPreset(options.preset) : undefined;
    if (options.preset && !preset) {
      console.error(chalk.red(`Unknown preset: ${options.preset}. Use: security-audit, performance, quick-scan, pre-commit, api-review`));
      db.close();
      process.exit(1);
    }

    // ── Build prompt based on input mode ──
    const focusArea = preset?.focus ?? options.focus ?? 'all';
    const focusConstraint = focusArea === 'all'
      ? 'Review for: correctness, bugs, security, performance, code quality'
      : `Focus specifically on: ${focusArea}`;
    const presetConstraints = preset?.constraints ?? [];

    const currentSession = sessionMgr.get(session.id);
    const sessionThreadId = currentSession?.codexThreadId ?? undefined;
    const isResumed = Boolean(sessionThreadId);

    let prompt: string;
    let promptPreview: string;
    const mode = modes[0];

    if (mode === 'prompt' || mode === 'stdin') {
      // ── Prompt mode: codex explores codebase via tools ──
      let instruction = options.prompt ?? '';
      if (mode === 'stdin') {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer);
        }
        instruction = Buffer.concat(chunks).toString('utf-8').trim();
        if (!instruction) {
          console.error(chalk.red('No input received from stdin'));
          db.close();
          process.exit(1);
        }
      }

      prompt = buildHandoffEnvelope({
        command: 'review',
        task: `TASK: ${instruction}\n\nStart by listing candidate files, then inspect them thoroughly.`,
        constraints: [focusConstraint, ...presetConstraints],
        scope: options.scope,
        resumed: isResumed,
      });

      promptPreview = `Prompt review: ${instruction.slice(0, 100)}`;
      console.error(chalk.cyan(`Reviewing via prompt (session: ${session.id.slice(0, 8)}...)...`));

    } else if (mode === 'diff') {
      // ── Diff mode: review git changes ──
      let diff: string;
      try {
        diff = execFileSync('git', ['diff', '--', ...(options.diff as string).split(/\s+/)], {
          cwd: projectDir,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024,
        });
      } catch (err) {
        console.error(chalk.red(`Failed to get diff for ${options.diff}: ${err instanceof Error ? err.message : String(err)}`));
        db.close();
        process.exit(1);
      }

      if (!diff.trim()) {
        console.error(chalk.yellow(`No changes in diff: ${options.diff}`));
        db.close();
        process.exit(0);
      }

      prompt = buildHandoffEnvelope({
        command: 'review',
        task: `Review the following code changes.\n\nGIT DIFF (${options.diff}):\n${diff.slice(0, REVIEW_DIFF_MAX_CHARS)}`,
        constraints: [focusConstraint, ...presetConstraints],
        resumed: isResumed,
      });

      promptPreview = `Diff review: ${options.diff}`;
      console.error(chalk.cyan(`Reviewing diff ${options.diff} (session: ${session.id.slice(0, 8)}...)...`));

    } else {
      // ── File mode (original behavior) ──
      // If input is a directory, auto-expand to recursive glob
      let globPattern = fileOrGlob as string;
      const resolvedInput = resolve(projectDir, globPattern);
      if (existsSync(resolvedInput) && statSync(resolvedInput).isDirectory()) {
        globPattern = `${globPattern}/**/*`;
        console.error(chalk.dim(`  Expanding directory to: ${globPattern}`));
      }
      const projectRoot = resolve(projectDir) + (process.platform === 'win32' ? '\\' : '/');
      const paths = globSync(globPattern, { cwd: projectDir })
        .map(p => resolve(projectDir, p))
        .filter(p => p.startsWith(projectRoot) || p === resolve(projectDir));
      if (paths.length === 0) {
        console.error(chalk.red(`No files matched: ${fileOrGlob}`));
        db.close();
        process.exit(1);
      }

      const files: { path: string; content: string }[] = [];
      let totalSize = 0;

      for (const filePath of paths) {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_FILE_SIZE) {
          console.error(chalk.yellow(`Skipping ${filePath} (${(stat.size / 1024).toFixed(0)}KB > 100KB limit)`));
          continue;
        }
        if (totalSize + stat.size > MAX_TOTAL_SIZE) {
          console.error(chalk.yellow(`Skipping remaining files (total would exceed 200KB)`));
          break;
        }

        const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
        const fd = openSync(filePath, 'r');
        const bytesRead = readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0);
        closeSync(fd);
        if (buf.subarray(0, bytesRead).includes(0)) {
          console.error(chalk.yellow(`Skipping ${filePath} (binary file)`));
          continue;
        }

        const content = readFileSync(filePath, 'utf-8');
        const relativePath = filePath.replace(projectDir, '').replace(/\\/g, '/').replace(/^\//, '');
        files.push({ path: relativePath, content });
        totalSize += stat.size;
      }

      if (files.length === 0) {
        console.error(chalk.red('No readable files to review'));
        db.close();
        process.exit(1);
      }

      const fileContents = files.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n');

      prompt = buildHandoffEnvelope({
        command: 'review',
        task: `Review the following code files.\n\nFILES TO REVIEW:\n${fileContents}`,
        constraints: [focusConstraint, ...presetConstraints],
        resumed: isResumed,
      });

      promptPreview = `Review ${files.length} file(s): ${files.map(f => f.path).join(', ')}`;
      console.error(chalk.cyan(`Reviewing ${files.length} file(s) via codex (session: ${session.id.slice(0, 8)}...)...`));
    }

    // ── Execute review via codex with session resume ──
    const timeoutMs = (options.timeout ?? 600) * 1000;
    const progress = createProgressCallbacks('review');

    const result = await (adapter as CliAdapter).callWithResume(prompt, {
      sessionId: sessionThreadId,
      timeout: timeoutMs,
      ...progress,
    });

    // Update session
    if (result.sessionId) {
      sessionMgr.updateThreadId(session.id, result.sessionId);
    }
    sessionMgr.addUsageFromResult(session.id, result.usage, prompt, result.text);

    sessionMgr.recordEvent({
      sessionId: session.id,
      command: 'review',
      subcommand: mode,
      promptPreview: promptPreview.slice(0, 500),
      responsePreview: result.text.slice(0, 500),
      promptFull: prompt,
      responseFull: result.text,
      usageJson: JSON.stringify(result.usage),
      durationMs: result.durationMs,
      codexThreadId: result.sessionId,
    });

    // ── Parse findings ──
    const findings: { severity: string; file: string; line: string; message: string }[] = [];
    for (const line of result.text.split('\n')) {
      const match = line.match(/^-\s*(CRITICAL|WARNING|INFO):\s*(\S+?)(?::(\d+))?\s+(.+)/);
      if (match) {
        findings.push({
          severity: match[1].toLowerCase(),
          file: match[2],
          line: match[3] ?? '?',
          message: match[4],
        });
      }
    }

    const tail = result.text.slice(-500);
    const verdictMatch = tail.match(/^(?:-\s*)?VERDICT:\s*(APPROVED|NEEDS_REVISION)/m);
    const scoreMatch = tail.match(/SCORE:\s*(\d+)\/10/);

    const output = {
      mode,
      findings,
      verdict: verdictMatch ? verdictMatch[1].toLowerCase() : 'unknown',
      score: scoreMatch ? Number.parseInt(scoreMatch[1], 10) : null,
      review: result.text.slice(0, 2000),
      sessionId: session.id,
      codexThreadId: result.sessionId,
      resumed: sessionThreadId ? result.sessionId === sessionThreadId : false,
      usage: result.usage,
      durationMs: result.durationMs,
    };

    // Human-readable summary on stderr
    const verdictColor = output.verdict === 'approved' ? chalk.green : chalk.red;
    console.error(verdictColor(`\nVerdict: ${output.verdict.toUpperCase()} (${output.score ?? '?'}/10)`));
    if (findings.length > 0) {
      console.error(chalk.yellow(`Findings (${findings.length}):`));
      for (const f of findings) {
        const sev = f.severity === 'critical' ? chalk.red('CRITICAL') :
          f.severity === 'warning' ? chalk.yellow('WARNING') : chalk.dim('INFO');
        console.error(`  ${sev} ${f.file}:${f.line} — ${f.message}`);
      }
    } else {
      console.error(chalk.green('No issues found.'));
    }
    console.error(chalk.dim(`Duration: ${(output.durationMs / 1000).toFixed(1)}s | Tokens: ${output.usage?.totalTokens ?? '?'}`));

    console.log(JSON.stringify(output, null, 2));
    db.close();
  } catch (error) {
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}
