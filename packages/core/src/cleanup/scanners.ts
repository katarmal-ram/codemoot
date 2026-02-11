// packages/core/src/cleanup/scanners.ts — Deterministic scanners (no LLM)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { Ignore } from 'ignore';
import type { CleanupConfidence, CleanupFinding, CleanupScope } from '../types/cleanup.js';

// ── Helpers ──

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const ALL_SCAN_EXTS = new Set([...SOURCE_EXTS, '.json']);

function normalizePath(filePath: string): string {
  return filePath.split(sep).join('/');
}

/** Walk files, respecting an optional compiled ignore filter. */
function walkFiles(dir: string, exts: Set<string>, result: string[] = [], rootDir?: string, ig?: Ignore): string[] {
  const root = rootDir ?? dir;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = normalizePath(relative(root, full));

    // Check ignore filter (compiled .gitignore + .codemootignore + builtins)
    if (ig && ig.ignores(rel)) continue;

    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkFiles(full, exts, result, root, ig);
    } else if (stat.isFile()) {
      const ext = full.slice(full.lastIndexOf('.'));
      if (exts.has(ext)) result.push(full);
    }
  }
  return result;
}

function readFileSafe(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function makeKey(scope: CleanupScope, file: string, symbol: string): string {
  return `${scope}:${normalizePath(file)}:${symbol}`;
}

// ── Find package.json files in monorepo ──

function findPackageJsons(projectDir: string): { dir: string; pkg: Record<string, unknown> }[] {
  const results: { dir: string; pkg: Record<string, unknown> }[] = [];

  // Root package.json
  const rootPkg = join(projectDir, 'package.json');
  if (existsSync(rootPkg)) {
    try {
      results.push({ dir: projectDir, pkg: JSON.parse(readFileSafe(rootPkg)) });
    } catch { /* skip */ }
  }

  // packages/*/package.json (one level of workspace nesting)
  const packagesDir = join(projectDir, 'packages');
  if (existsSync(packagesDir)) {
    try {
      for (const entry of readdirSync(packagesDir)) {
        const pkgJson = join(packagesDir, entry, 'package.json');
        if (existsSync(pkgJson)) {
          try {
            results.push({
              dir: join(packagesDir, entry),
              pkg: JSON.parse(readFileSafe(pkgJson)),
            });
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  return results;
}

// ── Scanner: Unused Dependencies ──

export function scanUnusedDeps(projectDir: string, ig?: Ignore): CleanupFinding[] {
  const findings: CleanupFinding[] = [];
  const packages = findPackageJsons(projectDir);

  for (const { dir, pkg } of packages) {
    const deps = pkg.dependencies as Record<string, string> | undefined;
    if (!deps) continue;

    const pkgName = (pkg.name as string) || relative(projectDir, dir);
    const files = walkFiles(dir, ALL_SCAN_EXTS, [], projectDir, ig);

    // Collect all file contents for searching
    const allContent = files.map(f => readFileSafe(f)).join('\n');

    for (const depName of Object.keys(deps)) {
      // Check if dep is imported/required anywhere in this package
      const importPatterns = [
        `from '${depName}`,
        `from "${depName}`,
        `require('${depName}`,
        `require("${depName}`,
        `import '${depName}`,
        `import "${depName}`,
        // Scoped subpath imports
        `from '${depName}/`,
        `from "${depName}/`,
        // Dynamic imports
        `import('${depName}`,
        `import("${depName}`,
      ];

      // Also check package.json bin/exports/scripts references (NOT dependencies itself)
      const binStr = JSON.stringify(pkg.bin ?? {});
      const exportsStr = JSON.stringify(pkg.exports ?? {});
      const scriptsStr = JSON.stringify(pkg.scripts ?? {});
      const usedInPkgJson = binStr.includes(depName) || exportsStr.includes(depName) || scriptsStr.includes(depName);

      const usedInSource = importPatterns.some(p => allContent.includes(p));

      if (!usedInSource && !usedInPkgJson) {
        const relFile = normalizePath(relative(projectDir, join(dir, 'package.json')));
        findings.push({
          key: makeKey('deps', relFile, depName),
          scope: 'deps',
          confidence: 'high',
          file: relFile,
          description: `Dependency "${depName}" is not imported in any source file`,
          recommendation: `Remove "${depName}" from dependencies`,
          deterministicEvidence: [`No import/require of "${depName}" found in ${files.length} files in ${pkgName}`],
          semanticEvidence: [],
          hostEvidence: [],
          sources: ['deterministic'],
          disputed: false,
          packageName: pkgName,
        });
      }
    }
  }

  return findings;
}

// ── Scanner: Unused Exports ──

export function scanUnusedExports(projectDir: string, ig?: Ignore): CleanupFinding[] {
  const findings: CleanupFinding[] = [];
  const allFiles = walkFiles(projectDir, SOURCE_EXTS, [], projectDir, ig);

  // Build a map of all exported symbols and their locations
  const exports: { file: string; name: string; line: number }[] = [];
  const exportRegex = /^export\s+(?:(?:async\s+)?function|class|const|let|var|type|interface|enum)\s+(\w+)/gm;
  const namedExportRegex = /export\s*\{([^}]+)\}/g;

  for (const file of allFiles) {
    const content = readFileSafe(file);
    const relFile = normalizePath(relative(projectDir, file));

    // Skip index/barrel files — they re-export
    if (relFile.endsWith('index.ts') || relFile.endsWith('index.js')) continue;

    let match: RegExpExecArray | null;

    exportRegex.lastIndex = 0;
    match = exportRegex.exec(content);
    while (match) {
      const lineNum = content.slice(0, match.index).split('\n').length;
      exports.push({ file: relFile, name: match[1], line: lineNum });
      match = exportRegex.exec(content);
    }

    namedExportRegex.lastIndex = 0;
    match = namedExportRegex.exec(content);
    while (match) {
      const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      const lineNum = content.slice(0, match.index).split('\n').length;
      for (const name of names) {
        exports.push({ file: relFile, name, line: lineNum });
      }
      match = namedExportRegex.exec(content);
    }
  }

  // Build all source content for import searching
  const allContent = allFiles.map(f => readFileSafe(f)).join('\n');

  for (const exp of exports) {
    // Simple check: does the export name appear in an import statement in any other file?
    const isUsed = allContent.includes(`{ ${exp.name}`) ||
      allContent.includes(`{${exp.name}`) ||
      allContent.includes(`, ${exp.name}`) ||
      allContent.includes(`${exp.name},`) ||
      allContent.includes(`${exp.name} }`) ||
      allContent.includes(`${exp.name}}`);

    // Count occurrences — subtract the export itself
    if (!isUsed) {
      findings.push({
        key: makeKey('unused-exports', exp.file, exp.name),
        scope: 'unused-exports',
        confidence: 'medium', // Could be dynamically imported or used via barrel
        file: exp.file,
        line: exp.line,
        description: `Export "${exp.name}" appears unused (no import found)`,
        recommendation: `Consider removing export "${exp.name}" or marking as internal`,
        deterministicEvidence: [`No import of "${exp.name}" found across ${allFiles.length} files`],
        semanticEvidence: [],
        hostEvidence: [],
        sources: ['deterministic'],
        disputed: false,
      });
    }
  }

  return findings;
}

// ── Scanner: Hardcoded Values ──

const MAGIC_NUMBER_REGEX = /(?<!\w)(\d{4,})(?!\w)/g; // 4+ digit numbers (3-digit too noisy)

/** Numbers commonly used as config values — not magic numbers. */
const COMMON_NUMBERS = new Set([
  1000, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
  1200, 1500, 2000, 3000, 5000, 8000, 8080, 8443, 9000, 9090,
  10000, 15000, 30000, 50000, 60000, 100000, 120000, 200000, 300000, 400000, 600000,
]);
const URL_REGEX = /(['"`])(https?:\/\/[^\s'"`]+)\1/g;
const CREDENTIAL_PATTERNS = [
  /(?:password|secret|token|api[_-]?key|auth)\s*[:=]\s*(['"`])(?!process\.env)[^'"`\n]+\1/gi,
];

export function scanHardcoded(projectDir: string, ig?: Ignore): CleanupFinding[] {
  const findings: CleanupFinding[] = [];
  const allFiles = walkFiles(projectDir, SOURCE_EXTS, [], projectDir, ig);

  for (const file of allFiles) {
    const relFile = normalizePath(relative(projectDir, file));

    // Skip test files for magic numbers (fixtures/mocks are expected)
    const isTest = relFile.includes('test') || relFile.includes('spec') || relFile.includes('__test');

    const content = readFileSafe(file);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip comments
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

      // Magic numbers (skip in tests, skip common values like ports, HTTP codes)
      if (!isTest) {
        const numberMatches = line.matchAll(MAGIC_NUMBER_REGEX);
        for (const m of numberMatches) {
          const num = Number.parseInt(m[1], 10);
          // Skip common legitimate values
          if (COMMON_NUMBERS.has(num)) continue;
          // Skip if it's clearly a size constant definition
          if (line.includes('const') || line.includes('=')) {
            // Allow: const MAX_SIZE = 512 * 1024
            if (/(?:const|let|var)\s+[A-Z_]+\s*=/.test(line)) continue;
          }

          findings.push({
            key: makeKey('hardcoded', relFile, `num:${m[1]}:L${lineNum}`),
            scope: 'hardcoded',
            confidence: 'medium',
            file: relFile,
            line: lineNum,
            description: `Magic number ${m[1]} found`,
            recommendation: `Extract to named constant`,
            deterministicEvidence: [`Literal number ${m[1]} at line ${lineNum}`],
            semanticEvidence: [],
          hostEvidence: [],
          sources: ['deterministic'],
            disputed: false,
          });
        }
      }

      // Hardcoded URLs (skip in tests)
      if (!isTest) {
        const urlMatches = line.matchAll(URL_REGEX);
        for (const m of urlMatches) {
          const urlKey = m[2].replace(/^https?:\/\//, '').split('/')[0];
          findings.push({
            key: makeKey('hardcoded', relFile, `url:${urlKey}:L${lineNum}`),
            scope: 'hardcoded',
            confidence: 'medium',
            file: relFile,
            line: lineNum,
            description: `Hardcoded URL: ${m[2].slice(0, 60)}`,
            recommendation: `Move to configuration or environment variable`,
            deterministicEvidence: [`URL literal at line ${lineNum}`],
            semanticEvidence: [],
          hostEvidence: [],
          sources: ['deterministic'],
            disputed: false,
          });
        }
      }

      // Credential patterns (skip in tests — mock tokens/secrets are expected)
      if (!isTest) for (const pattern of CREDENTIAL_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          findings.push({
            key: makeKey('hardcoded', relFile, `cred:L${lineNum}`),
            scope: 'hardcoded',
            confidence: 'high',
            file: relFile,
            line: lineNum,
            description: `Possible hardcoded credential`,
            recommendation: `Move to environment variable or secret manager`,
            deterministicEvidence: [`Credential pattern matched at line ${lineNum}`],
            semanticEvidence: [],
          hostEvidence: [],
          sources: ['deterministic'],
            disputed: false,
          });
        }
      }
    }
  }

  return findings;
}

// ── Scanner: Duplicates (report-only) ──

export function scanDuplicates(projectDir: string, ig?: Ignore): CleanupFinding[] {
  const findings: CleanupFinding[] = [];
  const allFiles = walkFiles(projectDir, SOURCE_EXTS, [], projectDir, ig);

  // Extract function bodies and hash them
  const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/g;
  const bodyMap = new Map<string, { file: string; name: string; line: number; hash: string }[]>();

  for (const file of allFiles) {
    const relFile = normalizePath(relative(projectDir, file));
    const content = readFileSafe(file);

    funcRegex.lastIndex = 0;
    let match = funcRegex.exec(content);
    while (match) {
      const startIdx = match.index + match[0].length;
      // Find matching closing brace (simple depth counting)
      let depth = 1;
      let endIdx = startIdx;
      while (endIdx < content.length && depth > 0) {
        if (content[endIdx] === '{') depth++;
        else if (content[endIdx] === '}') depth--;
        endIdx++;
      }

      const body = content.slice(startIdx, endIdx - 1);
      // Normalize: strip whitespace, variable names stay
      const normalized = body.replace(/\s+/g, ' ').trim();

      // Only consider non-trivial functions (>50 chars after normalization)
      if (normalized.length > 50) {
        const hash = createHash('md5').update(normalized).digest('hex');
        const lineNum = content.slice(0, match.index).split('\n').length;

        if (!bodyMap.has(hash)) bodyMap.set(hash, []);
        bodyMap.get(hash)!.push({ file: relFile, name: match[1], line: lineNum, hash });
      }

      match = funcRegex.exec(content);
    }
  }

  // Report groups with 2+ matches
  for (const [hash, group] of bodyMap) {
    if (group.length < 2) continue;

    const groupKey = group.map(g => `${g.file}:${g.line}`).sort().join('+');

    for (const item of group) {
      findings.push({
        key: makeKey('duplicates', item.file, `${hash.slice(0, 8)}:${item.name}`),
        scope: 'duplicates',
        confidence: 'low',
        file: item.file,
        line: item.line,
        description: `Function "${item.name}" has identical body to ${group.length - 1} other function(s)`,
        recommendation: `Consider extracting shared logic to a common utility`,
        deterministicEvidence: [`Body hash ${hash.slice(0, 8)} shared by: ${group.map(g => `${g.file}:${g.name}`).join(', ')}`],
        semanticEvidence: [],
        hostEvidence: [],
        sources: ['deterministic'],
        disputed: false,
        groupKey,
      });
    }
  }

  return findings;
}

// ── Scanner: Dead Code (report-only, intra-module) ──

export function scanDeadCode(projectDir: string, ig?: Ignore): CleanupFinding[] {
  const findings: CleanupFinding[] = [];
  const allFiles = walkFiles(projectDir, SOURCE_EXTS, [], projectDir, ig);

  // Find non-exported functions/variables that are only defined but never referenced
  const internalDeclRegex = /^(?!export)\s*(?:async\s+)?(?:function|const|let|var)\s+(\w+)/gm;

  for (const file of allFiles) {
    const relFile = normalizePath(relative(projectDir, file));
    const content = readFileSafe(file);

    // Skip very small files (likely stubs)
    if (content.length < 50) continue;

    internalDeclRegex.lastIndex = 0;
    let match = internalDeclRegex.exec(content);
    while (match) {
      const name = match[1];
      const lineNum = content.slice(0, match.index).split('\n').length;

      // Skip common patterns: single-letter vars, _prefixed, ALL_CAPS constants
      if (name.length <= 1 || name.startsWith('_')) {
        match = internalDeclRegex.exec(content);
        continue;
      }

      // Count occurrences of this name in the file (excluding the declaration itself)
      const regex = new RegExp(`\\b${name}\\b`, 'g');
      const occurrences = (content.match(regex) || []).length;

      // If name appears only once (the declaration), it's likely dead
      if (occurrences <= 1) {
        findings.push({
          key: makeKey('deadcode', relFile, name),
          scope: 'deadcode',
          confidence: 'low',
          file: relFile,
          line: lineNum,
          description: `"${name}" is declared but never referenced in this file`,
          recommendation: `Remove if unused, or export if needed elsewhere`,
          deterministicEvidence: [`"${name}" appears ${occurrences} time(s) in file (declaration only)`],
          semanticEvidence: [],
          hostEvidence: [],
          sources: ['deterministic'],
          disputed: false,
        });
      }

      match = internalDeclRegex.exec(content);
    }
  }

  return findings;
}

// ── Scanner: Security (OWASP vulnerability detection) ──

const SECURITY_PATTERNS: { regex: RegExp; cwe: string; severity: 'critical' | 'high' | 'medium'; description: string; recommendation: string }[] = [
  // CWE-94: Code Injection
  { regex: /\beval\s*\(/g, cwe: 'CWE-94', severity: 'critical', description: 'eval() usage — code injection risk', recommendation: 'Replace eval() with safe alternatives (JSON.parse, Function constructor with validation, or structured parsing)' },
  { regex: /\bnew\s+Function\s*\(/g, cwe: 'CWE-94', severity: 'critical', description: 'new Function() — dynamic code execution', recommendation: 'Avoid dynamic code generation; use static dispatch or lookup tables' },

  // CWE-78: OS Command Injection
  { regex: /child_process.*\bexec\s*\(\s*`/g, cwe: 'CWE-78', severity: 'critical', description: 'exec() with template literal — command injection risk', recommendation: 'Use execFile() with argument array instead of exec() with string interpolation' },
  { regex: /child_process.*\bexec\s*\(\s*[^'"`\s]+\s*\+/g, cwe: 'CWE-78', severity: 'critical', description: 'exec() with string concatenation — command injection risk', recommendation: 'Use execFile() with argument array instead of exec() with concatenation' },
  { regex: /\bexecSync\s*\(\s*`/g, cwe: 'CWE-78', severity: 'critical', description: 'execSync() with template literal — command injection', recommendation: 'Use execFileSync() with argument array' },

  // CWE-89: SQL Injection
  { regex: /\.(?:query|exec|run|prepare)\s*\(\s*`[^`]*\$\{/g, cwe: 'CWE-89', severity: 'critical', description: 'SQL query with template literal interpolation', recommendation: 'Use parameterized queries with ? placeholders' },
  { regex: /\.(?:query|exec|run)\s*\([^)]*\+/g, cwe: 'CWE-89', severity: 'high', description: 'SQL query with string concatenation', recommendation: 'Use parameterized queries instead of string building' },

  // CWE-22: Path Traversal
  { regex: /path\.(?:join|resolve)\s*\([^)]*(?:req\.|params\.|query\.|body\.)/g, cwe: 'CWE-22', severity: 'high', description: 'Path construction with user input — traversal risk', recommendation: 'Validate and normalize paths, reject .. segments, use path.normalize() + startsWith() check' },

  // CWE-79: Cross-Site Scripting
  { regex: /\.innerHTML\s*=/g, cwe: 'CWE-79', severity: 'high', description: 'innerHTML assignment — XSS risk', recommendation: 'Use textContent or a sanitization library (DOMPurify)' },
  { regex: /dangerouslySetInnerHTML/g, cwe: 'CWE-79', severity: 'medium', description: 'dangerouslySetInnerHTML — potential XSS', recommendation: 'Sanitize HTML before rendering; use DOMPurify or similar' },

  // CWE-601: Open Redirect
  { regex: /res\.redirect\s*\(\s*(?:req\.(?:query|params|body)\.|[^'"`\s])/g, cwe: 'CWE-601', severity: 'high', description: 'Redirect with user-controlled input — open redirect', recommendation: 'Validate redirect target against allowlist of safe URLs' },

  // CWE-798: Hardcoded Credentials (beyond what hardcoded scanner catches)
  { regex: /(?:jwt|bearer)\s*[:=]\s*['"`][A-Za-z0-9\-_.]+['"`]/gi, cwe: 'CWE-798', severity: 'high', description: 'Hardcoded JWT/Bearer token', recommendation: 'Move tokens to environment variables or secret manager' },

  // CWE-327: Weak Cryptography
  { regex: /createHash\s*\(\s*['"`](?:md5|sha1)['"`]\s*\)/g, cwe: 'CWE-327', severity: 'medium', description: 'Weak hash algorithm (MD5/SHA1)', recommendation: 'Use SHA-256 or stronger for security-sensitive hashing' },

  // CWE-1333: ReDoS
  { regex: /new\s+RegExp\s*\(\s*[^)]*(?:\.\*|\.\+|\(.*\|.*\))\s*[^)]*\)/g, cwe: 'CWE-1333', severity: 'medium', description: 'Dynamic regex with potential catastrophic backtracking', recommendation: 'Audit regex for ReDoS; consider using re2 or safe-regex library' },

  // CWE-200: Information Exposure
  { regex: /(?:console\.(?:log|error|warn)|res\.(?:json|send))\s*\(\s*(?:err|error|e)\s*\)/g, cwe: 'CWE-200', severity: 'medium', description: 'Full error object exposed — may leak stack traces/internals', recommendation: 'Log errors server-side; return sanitized error messages to clients' },

  // CWE-352: Missing CSRF (heuristic)
  { regex: /app\.(?:post|put|patch|delete)\s*\([^)]*,\s*(?:async\s+)?\([^)]*req/g, cwe: 'CWE-352', severity: 'medium', description: 'State-changing route without visible CSRF protection', recommendation: 'Add CSRF token validation middleware (csurf, csrf-csrf)' },
];

export function scanSecurity(projectDir: string, ig?: Ignore): CleanupFinding[] {
  const findings: CleanupFinding[] = [];
  const allFiles = walkFiles(projectDir, SOURCE_EXTS, [], projectDir, ig);

  for (const file of allFiles) {
    const relFile = normalizePath(relative(projectDir, file));
    const isTest = relFile.includes('test') || relFile.includes('spec') || relFile.includes('__test');
    // Skip test files — mock code intentionally uses unsafe patterns
    if (isTest) continue;

    const content = readFileSafe(file);
    const lines = content.split('\n');

    for (const pattern of SECURITY_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match = pattern.regex.exec(content);
      while (match) {
        const lineNum = content.slice(0, match.index).split('\n').length;
        const lineContent = lines[lineNum - 1]?.trim() || '';

        // Skip commented lines and regex/string literals (scanner definition patterns)
        if (lineContent.startsWith('//') || lineContent.startsWith('*') ||
            lineContent.startsWith('{ regex:') || lineContent.startsWith('regex:') ||
            /^\s*\//.test(lineContent) || /^\s*['"`].*['"`]\s*[,;]?\s*$/.test(lineContent)) {
          match = pattern.regex.exec(content);
          continue;
        }

        const confidence: CleanupConfidence = pattern.severity === 'critical' ? 'high' : pattern.severity === 'high' ? 'medium' : 'low';

        findings.push({
          key: makeKey('security', relFile, `${pattern.cwe}:L${lineNum}`),
          scope: 'security',
          confidence,
          file: relFile,
          line: lineNum,
          description: `[${pattern.cwe}] ${pattern.description}`,
          recommendation: pattern.recommendation,
          deterministicEvidence: [`Pattern matched at line ${lineNum}: ${lineContent.slice(0, 80)}`],
          semanticEvidence: [],
          hostEvidence: [],
          sources: ['deterministic'],
          disputed: false,
        });

        match = pattern.regex.exec(content);
      }
    }
  }

  return findings;
}

// ── Scanner: Near-Duplicates (fuzzy similarity) ──

/** Tokenize a function body: strip whitespace, normalize identifiers to placeholders */
function tokenize(body: string): string[] {
  return body
    .replace(/\/\/[^\n]*/g, '')      // strip line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // strip block comments
    .replace(/\s+/g, ' ')            // collapse whitespace
    .trim()
    .split(/(\W)/)                    // split on non-word chars, keep delimiters
    .filter(t => t.trim().length > 0);
}

/** Build n-gram set for Jaccard similarity */
function ngramSet(tokens: string[], n: number): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i++) {
    set.add(tokens.slice(i, i + n).join('|'));
  }
  return set;
}

/** Jaccard similarity between two sets */
function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface FuncEntry {
  file: string;
  name: string;
  line: number;
  tokens: string[];
  ngrams: Set<string>;
  bodyLength: number;
}

export function scanNearDuplicates(projectDir: string, ig?: Ignore): CleanupFinding[] {
  const findings: CleanupFinding[] = [];
  const allFiles = walkFiles(projectDir, SOURCE_EXTS, [], projectDir, ig);
  const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/g;
  const funcs: FuncEntry[] = [];

  // Extract all functions
  for (const file of allFiles) {
    const relFile = normalizePath(relative(projectDir, file));
    const content = readFileSafe(file);

    funcRegex.lastIndex = 0;
    let match = funcRegex.exec(content);
    while (match) {
      const startIdx = match.index + match[0].length;
      let depth = 1;
      let endIdx = startIdx;
      while (endIdx < content.length && depth > 0) {
        if (content[endIdx] === '{') depth++;
        else if (content[endIdx] === '}') depth--;
        endIdx++;
      }

      const body = content.slice(startIdx, endIdx - 1);
      const tokens = tokenize(body);

      // Only consider non-trivial functions (>20 tokens)
      if (tokens.length > 20) {
        const ngrams = ngramSet(tokens, 5);
        const lineNum = content.slice(0, match.index).split('\n').length;
        funcs.push({ file: relFile, name: match[1], line: lineNum, tokens, ngrams, bodyLength: body.length });
      }

      match = funcRegex.exec(content);
    }
  }

  // Compare all pairs (O(n^2) — bounded by function count, not file count)
  const reported = new Set<string>();
  for (let i = 0; i < funcs.length; i++) {
    for (let j = i + 1; j < funcs.length; j++) {
      const a = funcs[i];
      const b = funcs[j];

      // Skip exact same file+name (already caught by duplicates scanner)
      if (a.file === b.file && a.name === b.name) continue;

      // Quick size filter: bodies must be within 2x of each other
      const sizeRatio = Math.min(a.bodyLength, b.bodyLength) / Math.max(a.bodyLength, b.bodyLength);
      if (sizeRatio < 0.5) continue;

      const sim = jaccard(a.ngrams, b.ngrams);

      // Skip exact duplicates (handled by duplicates scanner)
      if (sim >= 0.98) continue;

      if (sim >= 0.70) {
        const pairKey = [a.file, a.name, b.file, b.name].sort().join('+');
        if (reported.has(pairKey)) continue;
        reported.add(pairKey);

        const confidence: CleanupConfidence = sim >= 0.90 ? 'high' : sim >= 0.80 ? 'medium' : 'low';
        const simPct = Math.round(sim * 100);

        // Report for the first function
        findings.push({
          key: makeKey('near-duplicates', a.file, `${a.name}~${b.name}`),
          scope: 'near-duplicates',
          confidence,
          file: a.file,
          line: a.line,
          description: `"${a.name}" is ${simPct}% similar to "${b.name}" in ${b.file}:${b.line}`,
          recommendation: `Consider extracting shared logic into a common utility function`,
          deterministicEvidence: [`Jaccard 5-gram similarity: ${simPct}% between ${a.name} (${a.file}:${a.line}) and ${b.name} (${b.file}:${b.line})`],
          semanticEvidence: [],
          hostEvidence: [],
          sources: ['deterministic'],
          disputed: false,
          groupKey: pairKey,
        });
      }
    }
  }

  return findings;
}

// ── Scanner: Anti-Patterns (AI code smells) ──

const ANTI_PATTERNS: { regex: RegExp; name: string; description: string; recommendation: string; confidence: CleanupConfidence; skipTests: boolean }[] = [
  // Empty catch blocks
  { regex: /catch\s*\([^)]*\)\s*\{\s*\}/g, name: 'empty-catch', description: 'Empty catch block swallows errors silently', recommendation: 'Log the error or re-throw; empty catches hide bugs', confidence: 'high', skipTests: false },
  { regex: /catch\s*\{\s*\}/g, name: 'empty-catch', description: 'Empty catch block (no parameter) swallows errors', recommendation: 'At minimum add a comment explaining why errors are ignored', confidence: 'high', skipTests: false },

  // console.log in production code
  { regex: /\bconsole\.log\s*\(/g, name: 'console-log', description: 'console.log left in production code', recommendation: 'Remove or replace with proper logger', confidence: 'medium', skipTests: true },

  // async function without await
  { regex: /async\s+function\s+(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/g, name: 'async-no-await', description: 'async function may not need async keyword', recommendation: 'Remove async if function does not use await', confidence: 'low', skipTests: true },

  // Redundant return undefined
  { regex: /return\s+undefined\s*;/g, name: 'return-undefined', description: 'Redundant "return undefined" — functions return undefined by default', recommendation: 'Use bare "return;" or remove the return statement', confidence: 'medium', skipTests: false },

  // Nested ternaries (readability hazard)
  { regex: /\?[^:?]*\?/g, name: 'nested-ternary', description: 'Nested ternary operator — hard to read', recommendation: 'Refactor to if/else or extract to a helper function', confidence: 'low', skipTests: true },

  // Type assertion chains (TypeScript)
  { regex: /as\s+\w+(?:\s*\[\s*\])?\s+as\s+/g, name: 'double-assertion', description: 'Double type assertion (as X as Y) — type safety bypass', recommendation: 'Fix the underlying type instead of double-casting', confidence: 'high', skipTests: false },

  // any type usage
  { regex: /:\s*any\b/g, name: 'any-type', description: '"any" type defeats TypeScript type safety', recommendation: 'Use unknown, proper generics, or specific types', confidence: 'low', skipTests: true },

  // Promise constructor anti-pattern
  { regex: /new\s+Promise\s*\(\s*(?:async\s+)?\(\s*resolve\s*(?:,\s*reject)?\s*\)\s*=>\s*\{[^}]*await\b/g, name: 'promise-constructor-async', description: 'Promise constructor with async executor — error handling is broken', recommendation: 'Remove Promise wrapper; async functions already return promises', confidence: 'high', skipTests: false },

  // setTimeout/setInterval with string argument
  { regex: /(?:setTimeout|setInterval)\s*\(\s*['"`]/g, name: 'implicit-eval', description: 'setTimeout/setInterval with string argument — implicit eval()', recommendation: 'Pass a function reference instead of a string', confidence: 'high', skipTests: false },
];

export function scanAntiPatterns(projectDir: string, ig?: Ignore): CleanupFinding[] {
  const findings: CleanupFinding[] = [];
  const allFiles = walkFiles(projectDir, SOURCE_EXTS, [], projectDir, ig);

  for (const file of allFiles) {
    const relFile = normalizePath(relative(projectDir, file));
    const isTest = relFile.includes('test') || relFile.includes('spec') || relFile.includes('__test');
    const content = readFileSafe(file);
    const lines = content.split('\n');

    for (const pattern of ANTI_PATTERNS) {
      if (pattern.skipTests && isTest) continue;

      pattern.regex.lastIndex = 0;

      // Special handling for async-no-await: need to check function body
      if (pattern.name === 'async-no-await') {
        let match = pattern.regex.exec(content);
        while (match) {
          const funcName = match[1];
          const startIdx = match.index + match[0].length;
          let depth = 1;
          let endIdx = startIdx;
          while (endIdx < content.length && depth > 0) {
            if (content[endIdx] === '{') depth++;
            else if (content[endIdx] === '}') depth--;
            endIdx++;
          }
          const body = content.slice(startIdx, endIdx - 1);
          if (!body.includes('await ') && !body.includes('await(') && !body.includes('for await')) {
            const lineNum = content.slice(0, match.index).split('\n').length;
            findings.push({
              key: makeKey('anti-patterns', relFile, `${pattern.name}:${funcName}:L${lineNum}`),
              scope: 'anti-patterns',
              confidence: pattern.confidence,
              file: relFile,
              line: lineNum,
              description: `${pattern.description}: "${funcName}"`,
              recommendation: pattern.recommendation,
              deterministicEvidence: [`async function "${funcName}" at line ${lineNum} contains no await expressions`],
              semanticEvidence: [],
              hostEvidence: [],
              sources: ['deterministic'],
              disputed: false,
            });
          }
          match = pattern.regex.exec(content);
        }
        continue;
      }

      let match = pattern.regex.exec(content);
      while (match) {
        const lineNum = content.slice(0, match.index).split('\n').length;
        const lineContent = lines[lineNum - 1]?.trim() || '';

        // Skip commented lines and regex/string literals (scanner definition patterns)
        if (lineContent.startsWith('//') || lineContent.startsWith('*') ||
            lineContent.startsWith('{ regex:') || lineContent.startsWith('regex:') ||
            /^\s*\//.test(lineContent)) {
          match = pattern.regex.exec(content);
          continue;
        }

        findings.push({
          key: makeKey('anti-patterns', relFile, `${pattern.name}:L${lineNum}`),
          scope: 'anti-patterns',
          confidence: pattern.confidence,
          file: relFile,
          line: lineNum,
          description: pattern.description,
          recommendation: pattern.recommendation,
          deterministicEvidence: [`Pattern matched at line ${lineNum}: ${lineContent.slice(0, 80)}`],
          semanticEvidence: [],
          hostEvidence: [],
          sources: ['deterministic'],
          disputed: false,
        });

        match = pattern.regex.exec(content);
      }
    }
  }

  return findings;
}

// ── Run all scanners ──

export function runAllScanners(
  projectDir: string,
  scopes: CleanupScope[],
  ig?: Ignore,
): CleanupFinding[] {
  const findings: CleanupFinding[] = [];
  const ALL_SCOPES: CleanupScope[] = ['deps', 'unused-exports', 'hardcoded', 'duplicates', 'deadcode', 'security', 'near-duplicates', 'anti-patterns'];
  const activeScopes = new Set(scopes.includes('all' as CleanupScope) ? ALL_SCOPES : scopes);

  if (activeScopes.has('deps')) findings.push(...scanUnusedDeps(projectDir, ig));
  if (activeScopes.has('unused-exports')) findings.push(...scanUnusedExports(projectDir, ig));
  if (activeScopes.has('hardcoded')) findings.push(...scanHardcoded(projectDir, ig));
  if (activeScopes.has('duplicates')) findings.push(...scanDuplicates(projectDir, ig));
  if (activeScopes.has('deadcode')) findings.push(...scanDeadCode(projectDir, ig));
  if (activeScopes.has('security')) findings.push(...scanSecurity(projectDir, ig));
  if (activeScopes.has('near-duplicates')) findings.push(...scanNearDuplicates(projectDir, ig));
  if (activeScopes.has('anti-patterns')) findings.push(...scanAntiPatterns(projectDir, ig));

  // Sort by key for deterministic output
  findings.sort((a, b) => a.key.localeCompare(b.key));
  return findings;
}
