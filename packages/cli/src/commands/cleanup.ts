// packages/cli/src/commands/cleanup.ts — AI slop scanner with 3-way merge (deterministic + codex + host)

import type { CleanupFinding, CleanupReport, CleanupScope } from '@codemoot/core';
import {
  BuildStore,
  CliAdapter,
  JobStore,
  ModelRegistry,
  SessionManager,
  buildHandoffEnvelope,
  computeThreeWayStats,
  createIgnoreFilter,
  generateId,
  hostFindingsSchema,
  loadConfig,
  mergeThreeWay,
  openDatabase,
  recalculateConfidenceStats,
  runAllScanners,
} from '@codemoot/core';
import chalk from 'chalk';
import { readFileSync } from 'node:fs';

import { createProgressCallbacks } from '../progress.js';
import { getDbPath } from '../utils.js';

interface CleanupOptions {
  scope: string;
  timeout: number;
  maxDisputes: number;
  hostFindings?: string;
  background?: boolean;
  output?: string;
  noGitignore?: boolean;
  quiet?: boolean;
}

export async function cleanupCommand(path: string, options: CleanupOptions): Promise<void> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const { resolve } = await import('node:path');
    const projectDir = resolve(path);

    // ── Background mode: enqueue and return immediately ──
    if (options.background) {
      const bgDb = openDatabase(getDbPath());
      const jobStore = new JobStore(bgDb);
      const jobId = jobStore.enqueue({
        type: 'cleanup',
        payload: { path: projectDir, scope: options.scope, timeout: options.timeout, maxDisputes: options.maxDisputes, hostFindings: options.hostFindings, output: options.output },
      });
      console.log(JSON.stringify({ jobId, status: 'queued', message: 'Cleanup enqueued. Check with: codemoot jobs status ' + jobId }));
      bgDb.close();
      return;
    }

    const scopes = options.scope === 'all'
      ? ['deps', 'unused-exports', 'hardcoded', 'duplicates', 'deadcode', 'security', 'near-duplicates', 'anti-patterns'] as CleanupScope[]
      : [options.scope as CleanupScope];

    const dbPath = getDbPath();
    db = openDatabase(dbPath);
    const buildStore = new BuildStore(db);
    const buildId = generateId();
    const startTime = Date.now();

    // Create build run for tracking
    buildStore.create({ buildId, task: `cleanup:${options.scope}` });

    console.error(chalk.cyan(`Cleanup scan started (ID: ${buildId})`));
    console.error(chalk.cyan(`Scopes: ${scopes.join(', ')}`));
    console.error(chalk.cyan(`Project: ${projectDir}`));

    // ── Load host findings if provided ──
    let hostFindings: CleanupFinding[] = [];
    if (options.hostFindings) {
      console.error(chalk.cyan(`Host findings: ${options.hostFindings}`));
      try {
        const raw = readFileSync(options.hostFindings, 'utf-8');
        const parsed = JSON.parse(raw);
        const validated = hostFindingsSchema.parse(parsed);

        hostFindings = validated.map(f => ({
          key: `${f.scope}:${f.file}:${f.symbol}`,
          scope: f.scope as CleanupScope,
          confidence: f.confidence as CleanupFinding['confidence'],
          file: f.file,
          line: f.line,
          description: f.description,
          recommendation: f.recommendation,
          deterministicEvidence: [],
          semanticEvidence: [],
          hostEvidence: [`Host: ${f.description}`],
          sources: ['host'] as CleanupFinding['sources'],
          disputed: false,
        }));
        console.error(chalk.dim(`  [host] Loaded ${hostFindings.length} findings`));
      } catch (err) {
        console.error(chalk.red(`Failed to load host findings: ${err instanceof Error ? err.message : String(err)}`));
        db.close();
        process.exit(1);
      }
    }

    // ── Build ignore filter ──
    const ig = createIgnoreFilter(projectDir, { skipGitignore: options.noGitignore });

    // ── Phase 1: Parallel scan ──
    console.error(chalk.yellow('\nPhase 1: Scanning (parallel)...'));

    // Resolve codex adapter
    let codexAdapter: CliAdapter | null = null;
    try {
      const config = loadConfig();
      const registry = ModelRegistry.fromConfig(config, projectDir);
      try {
        codexAdapter = registry.getAdapter('codex-reviewer') as CliAdapter;
      } catch {
        try {
          codexAdapter = registry.getAdapter('codex-architect') as CliAdapter;
        } catch { /* no adapter */ }
      }
    } catch { /* config not found */ }

    // Resolve unified session
    const sessionMgr = new SessionManager(db);
    const session = sessionMgr.resolveActive('cleanup');
    const overflowCheck = sessionMgr.preCallOverflowCheck(session.id);
    if (overflowCheck.rolled) {
      console.error(chalk.yellow(`  ${overflowCheck.message}`));
    }
    const currentSession = sessionMgr.get(session.id);
    const sessionThreadId = currentSession?.codexThreadId ?? undefined;

    // Run both scanners in parallel
    const [deterministicFindings, semanticFindings] = await Promise.all([
      Promise.resolve().then(() => {
        console.error(chalk.dim('  [deterministic] Starting...'));
        const findings = runAllScanners(projectDir, scopes, ig);
        console.error(chalk.dim(`  [deterministic] Done: ${findings.length} findings`));
        return findings;
      }),
      runCodexScan(codexAdapter, projectDir, scopes, options.timeout, sessionMgr, session.id, sessionThreadId),
    ]);

    // Record scan event
    buildStore.updateWithEvent(
      buildId,
      { status: 'reviewing', currentPhase: 'review', metadata: { cleanupPhase: 'scan' } },
      {
        eventType: 'scan_completed',
        actor: 'system',
        phase: 'review',
        payload: {
          deterministicCount: deterministicFindings.length,
          semanticCount: semanticFindings.length,
          hostCount: hostFindings.length,
        },
      },
    );

    // ── Phase 2: 3-way merge ──
    console.error(chalk.yellow('\nPhase 2: Merging findings (3-way)...'));

    const mergedFindings = mergeThreeWay(deterministicFindings, semanticFindings, hostFindings);
    const stats = computeThreeWayStats(deterministicFindings, semanticFindings, hostFindings, mergedFindings);

    console.error(chalk.dim(`  Merged: ${mergedFindings.length} total, ${stats.agreed} agreed, ${stats.disputed} disputed`));
    if (hostFindings.length > 0) {
      console.error(chalk.dim(`  Sources: deterministic=${stats.deterministic}, codex=${stats.semantic}, host=${stats.host}`));
    }

    buildStore.updateWithEvent(
      buildId,
      { metadata: { cleanupPhase: 'merge' } },
      {
        eventType: 'merge_completed',
        actor: 'system',
        phase: 'review',
        payload: { totalFindings: mergedFindings.length, ...stats },
      },
    );

    // ── Phase 2.5: Adjudicate disputed findings ──
    const hasAdjudicatable = stats.disputed > 0 || mergedFindings.some(f => f.confidence === 'medium');
    if (codexAdapter && hasAdjudicatable && options.maxDisputes > 0) {
      console.error(chalk.yellow(`\nPhase 2.5: Adjudicating up to ${options.maxDisputes} disputed findings...`));
      await adjudicateFindings(codexAdapter, mergedFindings, options.maxDisputes, stats);

      buildStore.updateWithEvent(
        buildId,
        { metadata: { cleanupPhase: 'adjudicate' } },
        {
          eventType: 'adjudicated',
          actor: 'codex',
          phase: 'review',
          payload: { adjudicated: stats.adjudicated },
        },
      );
    }

    // ── Phase 3: Output report ──
    const durationMs = Date.now() - startTime;

    const actionableScopes = new Set<CleanupScope>(['deps', 'unused-exports', 'hardcoded']);
    const actionableCount = mergedFindings.filter(f =>
      actionableScopes.has(f.scope) && (f.confidence === 'high' || f.confidence === 'medium'),
    ).length;

    const report: CleanupReport = {
      scopes,
      findings: mergedFindings.sort((a, b) => {
        const confOrder = { high: 0, medium: 1, low: 2 };
        const confDiff = confOrder[a.confidence] - confOrder[b.confidence];
        if (confDiff !== 0) return confDiff;
        return a.key.localeCompare(b.key);
      }),
      stats,
      durationMs,
    };

    buildStore.updateWithEvent(
      buildId,
      { status: 'completed', currentPhase: 'done', completedAt: Date.now() },
      {
        eventType: 'phase_transition',
        actor: 'system',
        phase: 'done',
        payload: {
          totalFindings: mergedFindings.length,
          actionable: actionableCount,
          reportOnly: mergedFindings.length - actionableCount,
        },
      },
    );

    console.error(chalk.green(`\nScan complete in ${(durationMs / 1000).toFixed(1)}s`));
    console.error(chalk.green(`Build ID: ${buildId}`));
    console.error(`  Actionable: ${chalk.red(String(actionableCount))}`);
    console.error(`  Report-only: ${chalk.dim(String(mergedFindings.length - actionableCount))}`);
    console.error(`  High: ${stats.highConfidence} | Medium: ${stats.mediumConfidence} | Low: ${stats.lowConfidence}`);
    if (stats.adjudicated > 0) console.error(`  Adjudicated: ${stats.adjudicated}`);

    // ── Human-readable summary (stderr) ──
    if (!options.quiet && mergedFindings.length > 0) {
      console.error(chalk.yellow('\n── Findings Summary ──'));
      const byScope = new Map<string, CleanupFinding[]>();
      for (const f of report.findings) {
        const arr = byScope.get(f.scope) ?? [];
        arr.push(f);
        byScope.set(f.scope, arr);
      }
      for (const [scope, items] of byScope) {
        const high = items.filter(f => f.confidence === 'high').length;
        const med = items.filter(f => f.confidence === 'medium').length;
        const low = items.filter(f => f.confidence === 'low').length;
        console.error(chalk.cyan(`\n  ${scope} (${items.length})`));
        // Show up to 5 high/medium findings per scope
        for (const f of items.filter(i => i.confidence !== 'low').slice(0, 5)) {
          const conf = f.confidence === 'high' ? chalk.red('HIGH') : chalk.yellow('MED');
          const loc = f.line ? `${f.file}:${f.line}` : f.file;
          console.error(`    ${conf} ${loc} — ${f.description}`);
        }
        if (high + med > 5) {
          console.error(chalk.dim(`    ... and ${high + med - 5} more`));
        }
        if (low > 0) {
          console.error(chalk.dim(`    + ${low} low-confidence (report-only)`));
        }
      }
      console.error('');
    }

    // Persist findings in session_events.response_full
    sessionMgr.recordEvent({
      sessionId: session.id,
      command: 'cleanup',
      subcommand: 'report',
      promptPreview: `Cleanup: ${scopes.join(', ')} on ${projectDir}`,
      responsePreview: `${mergedFindings.length} findings (${stats.highConfidence} high, ${stats.mediumConfidence} med, ${stats.lowConfidence} low)`,
      responseFull: JSON.stringify(report),
      durationMs,
    });

    // --output: write findings to file
    if (options.output) {
      const { writeFileSync } = await import('node:fs');
      // Write directly (atomic rename fails on Windows if target exists)
      writeFileSync(options.output, JSON.stringify(report, null, 2), 'utf-8');
      console.error(chalk.green(`  Findings written to ${options.output}`));
    }

    console.log(JSON.stringify(report, null, 2));

    db.close();
  } catch (error) {
    db?.close();
    console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
    process.exit(1);
  }
}

// ── Codex semantic scan ──

async function runCodexScan(
  adapter: CliAdapter | null,
  _projectDir: string,
  scopes: CleanupScope[],
  timeoutSec: number,
  sessionMgr?: SessionManager,
  sessionId?: string,
  sessionThreadId?: string,
): Promise<CleanupFinding[]> {
  if (!adapter) {
    console.error(chalk.yellow('  [codex] No adapter available — skipping semantic scan'));
    return [];
  }

  console.error(chalk.dim('  [codex] Starting semantic scan...'));

  const scopeDescriptions = scopes.map(s => {
    if (s === 'deps') return 'unused dependencies (check each package.json dep, including dynamic imports)';
    if (s === 'unused-exports') return 'unused exports (exported but never imported anywhere)';
    if (s === 'hardcoded') return 'hardcoded values (magic numbers, URLs, credentials)';
    if (s === 'duplicates') return 'duplicate logic (similar function bodies across files)';
    if (s === 'deadcode') return 'dead code (unreachable or unused internal code)';
    return s;
  }).join(', ');

  const prompt = buildHandoffEnvelope({
    command: 'cleanup',
    task: `Scan this codebase for AI slop and code quality issues.

SCAN FOR: ${scopeDescriptions}

Where scope/confidence/file/line/symbol fields are:
- scope: deps, unused-exports, hardcoded, duplicates, or deadcode
- confidence: high, medium, or low
- file: relative path from project root (forward slashes)
- line: line number (or 0 if N/A)
- symbol: the specific identifier (dep name, export name, variable name, or content hash)

IMPORTANT KEY FORMAT: The key will be built as scope:file:symbol — use the SAME symbol that a static scanner would use:
- deps: the package name (e.g. "lodash")
- unused-exports: the export name (e.g. "myFunction")
- hardcoded: for numbers use "num:VALUE:LLINE" (e.g. "num:42:L15"), for URLs use "url:HOSTNAME:LLINE" (e.g. "url:api.example.com:L20"), for credentials use "cred:LLINE" (e.g. "cred:L15")
- duplicates: "HASH:FUNCNAME" where HASH is first 8 chars of md5 of normalized body (e.g. "a1b2c3d4:myFunction")
- deadcode: the function/variable name`,
    constraints: [
      'Be thorough but precise. Only report real issues you can verify.',
      'Check for dynamic imports (import()) before flagging unused deps',
      'Check barrel re-exports and index files before flagging unused exports',
      'Check type-only imports (import type)',
      'Check framework conventions and cross-package monorepo dependencies',
    ],
    resumed: Boolean(sessionThreadId),
  });

  try {
    const progress = createProgressCallbacks('cleanup-scan');
    const result = await adapter.callWithResume(prompt, { sessionId: sessionThreadId, timeout: timeoutSec * 1000, ...progress });

    // Update unified session
    if (sessionMgr && sessionId) {
      if (result.sessionId) {
        sessionMgr.updateThreadId(sessionId, result.sessionId);
      }
      sessionMgr.addUsageFromResult(sessionId, result.usage, prompt, result.text);
      sessionMgr.recordEvent({
        sessionId,
        command: 'cleanup',
        subcommand: 'scan',
        promptPreview: `Cleanup scan: ${scopes.join(', ')}`,
        responsePreview: result.text.slice(0, 500),
        usageJson: JSON.stringify(result.usage),
        durationMs: result.durationMs,
        codexThreadId: result.sessionId,
      });
    }

    const findings: CleanupFinding[] = [];
    for (const line of result.text.split('\n')) {
      const match = line.match(/^FINDING:\s*([^|]+)\|([^|]+)\|([^|]+)\|(\d+)\|([^|]+)\|([^|]+)\|(.+)/);
      if (match) {
        const scope = match[1].trim() as CleanupScope;
        if (!scopes.includes(scope)) continue;

        const file = match[3].trim();
        const symbol = match[5].trim();
        findings.push({
          key: `${scope}:${file}:${symbol}`,
          scope,
          confidence: match[2].trim() as CleanupFinding['confidence'],
          file,
          line: Number.parseInt(match[4], 10) || undefined,
          description: match[6].trim(),
          recommendation: match[7].trim(),
          deterministicEvidence: [],
          semanticEvidence: [`Codex: ${match[6].trim()}`],
          hostEvidence: [],
          sources: ['semantic'],
          disputed: false,
        });
      }
    }

    console.error(chalk.dim(`  [codex] Done: ${findings.length} findings`));
    return findings;
  } catch (error) {
    console.error(chalk.yellow(`  [codex] Scan failed: ${error instanceof Error ? error.message : String(error)}`));
    return [];
  }
}

// ── Adjudication ──

async function adjudicateFindings(
  adapter: CliAdapter,
  findings: CleanupFinding[],
  maxDisputes: number,
  stats: CleanupReport['stats'],
): Promise<void> {
  const toAdjudicate = findings
    .filter(f => f.disputed || f.confidence === 'medium')
    .slice(0, maxDisputes);

  for (const finding of toAdjudicate) {
    try {
      const allEvidence = [...finding.deterministicEvidence, ...finding.semanticEvidence, ...finding.hostEvidence];
      const prompt = buildHandoffEnvelope({
        command: 'adjudicate',
        task: `Verify this finding.\n\nFINDING: ${finding.description}\nFILE: ${finding.file}${finding.line ? `:${finding.line}` : ''}\nSCOPE: ${finding.scope}\nSOURCES: ${finding.sources.join(', ')}\nEVIDENCE: ${allEvidence.join('; ')}`,
        constraints: ['Check for dynamic imports, barrel re-exports, type-only usage, runtime/indirect usage'],
        resumed: false,
      });

      const adjProgress = createProgressCallbacks('adjudicate');
      const result = await adapter.callWithResume(prompt, { timeout: 60_000, ...adjProgress });

      const match = result.text.match(/ADJUDICATE:\s*(CONFIRMED|DISMISSED|UNCERTAIN)\s+(.*)/);
      if (match) {
        const verdict = match[1];
        if (verdict === 'CONFIRMED') {
          finding.confidence = 'high';
          finding.semanticEvidence.push(`Adjudicated: CONFIRMED — ${match[2]}`);
        } else if (verdict === 'DISMISSED') {
          finding.confidence = 'low';
          finding.semanticEvidence.push(`Adjudicated: DISMISSED — ${match[2]}`);
        } else {
          // UNCERTAIN — keep disputed, don't count as adjudicated
          finding.semanticEvidence.push(`Adjudicated: UNCERTAIN — ${match[2]}`);
          continue;
        }
        finding.disputed = false;
        stats.adjudicated++;
      }
    } catch {
      // Adjudication failed — keep as-is
    }
  }

  recalculateConfidenceStats(findings, stats);
}
