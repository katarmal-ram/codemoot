// tests/unit/cleanup/scanners.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  scanUnusedDeps,
  scanUnusedExports,
  scanHardcoded,
  scanDuplicates,
  scanDeadCode,
  runAllScanners,
} from '../../../src/cleanup/index.js';

function createTmpDir(): string {
  const dir = join(tmpdir(), `codemoot-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, path: string, content: string): void {
  const full = join(dir, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

describe('scanUnusedDeps', () => {
  let dir: string;

  beforeEach(() => { dir = createTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('finds unused dependency', () => {
    writeFile(dir, 'package.json', JSON.stringify({
      name: 'test-pkg',
      dependencies: { lodash: '^4.0.0', chalk: '^5.0.0' },
    }));
    writeFile(dir, 'src/index.ts', "import chalk from 'chalk';\nconsole.log(chalk.red('hi'));");

    const findings = scanUnusedDeps(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0].scope).toBe('deps');
    expect(findings[0].description).toContain('lodash');
    expect(findings[0].confidence).toBe('high');
  });

  it('returns empty for all-used deps', () => {
    writeFile(dir, 'package.json', JSON.stringify({
      name: 'test-pkg',
      dependencies: { chalk: '^5.0.0' },
    }));
    writeFile(dir, 'src/index.ts', "import chalk from 'chalk';");

    const findings = scanUnusedDeps(dir);
    expect(findings).toHaveLength(0);
  });

  it('scans monorepo packages', () => {
    writeFile(dir, 'package.json', JSON.stringify({ name: 'root', dependencies: {} }));
    writeFile(dir, 'packages/foo/package.json', JSON.stringify({
      name: '@test/foo',
      dependencies: { zod: '^3.0.0', yaml: '^2.0.0' },
    }));
    writeFile(dir, 'packages/foo/src/index.ts', "import { z } from 'zod';");

    const findings = scanUnusedDeps(dir);
    expect(findings.some(f => f.description.includes('yaml'))).toBe(true);
    expect(findings.some(f => f.description.includes('zod'))).toBe(false);
  });
});

describe('scanUnusedExports', () => {
  let dir: string;

  beforeEach(() => { dir = createTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('finds unused export', () => {
    writeFile(dir, 'src/utils.ts', 'export function used() {}\nexport function unused() {}');
    writeFile(dir, 'src/main.ts', "import { used } from './utils.js';");

    const findings = scanUnusedExports(dir);
    expect(findings.some(f => f.description.includes('unused'))).toBe(true);
  });

  it('skips index files (barrel exports)', () => {
    writeFile(dir, 'src/index.ts', 'export { foo } from "./foo.js";');
    writeFile(dir, 'src/foo.ts', 'export function foo() {}');

    const findings = scanUnusedExports(dir);
    // index.ts should be skipped, foo is re-exported
    const indexFindings = findings.filter(f => f.file.includes('index'));
    expect(indexFindings).toHaveLength(0);
  });
});

describe('scanHardcoded', () => {
  let dir: string;

  beforeEach(() => { dir = createTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('finds hardcoded URLs', () => {
    writeFile(dir, 'src/api.ts', 'const endpoint = "https://api.example.com/v1";');

    const findings = scanHardcoded(dir);
    expect(findings.some(f => f.description.includes('URL'))).toBe(true);
  });

  it('skips test files for magic numbers', () => {
    writeFile(dir, 'tests/math.test.ts', 'expect(result).toBe(12345);');

    const findings = scanHardcoded(dir);
    const magicFindings = findings.filter(f => f.description.includes('Magic number'));
    expect(magicFindings).toHaveLength(0);
  });

  it('skips named constants', () => {
    writeFile(dir, 'src/config.ts', 'const MAX_RETRIES = 500;');

    const findings = scanHardcoded(dir);
    const magicFindings = findings.filter(f => f.description.includes('500'));
    expect(magicFindings).toHaveLength(0);
  });
});

describe('scanDuplicates', () => {
  let dir: string;

  beforeEach(() => { dir = createTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('finds duplicate function bodies', () => {
    const body = `
  const result = items.filter(i => i.active).map(i => i.name).sort();
  return result.join(', ');
`;
    writeFile(dir, 'src/a.ts', `function getNames(items: any[]) {${body}}`);
    writeFile(dir, 'src/b.ts', `function listNames(items: any[]) {${body}}`);

    const findings = scanDuplicates(dir);
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings[0].scope).toBe('duplicates');
    expect(findings[0].confidence).toBe('low');
  });

  it('ignores trivial functions', () => {
    writeFile(dir, 'src/a.ts', 'function foo() { return 1; }');
    writeFile(dir, 'src/b.ts', 'function bar() { return 1; }');

    const findings = scanDuplicates(dir);
    // Too short (< 50 chars normalized) — should be empty
    expect(findings).toHaveLength(0);
  });
});

describe('scanDeadCode', () => {
  let dir: string;

  beforeEach(() => { dir = createTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('finds unused internal function', () => {
    writeFile(dir, 'src/utils.ts', `
export function publicFn() { return helper(); }
function helper() { return 42; }
function neverCalled() { return 0; }
`);

    const findings = scanDeadCode(dir);
    expect(findings.some(f => f.description.includes('neverCalled'))).toBe(true);
    expect(findings.some(f => f.description.includes('helper'))).toBe(false);
  });
});

describe('runAllScanners', () => {
  let dir: string;

  beforeEach(() => { dir = createTmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('runs selected scopes only', () => {
    writeFile(dir, 'package.json', JSON.stringify({ name: 'test', dependencies: { unused: '1.0' } }));
    writeFile(dir, 'src/index.ts', 'console.log("hi");');

    const findings = runAllScanners(dir, ['deps']);
    expect(findings.every(f => f.scope === 'deps')).toBe(true);
  });

  it('returns deterministic sort order', () => {
    writeFile(dir, 'package.json', JSON.stringify({ name: 'test', dependencies: { aaa: '1.0', zzz: '1.0' } }));
    writeFile(dir, 'src/index.ts', '');

    const findings = runAllScanners(dir, ['deps']);
    const keys = findings.map(f => f.key);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});
