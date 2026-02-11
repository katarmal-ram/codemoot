import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextBuilder, buildHandoffEnvelope } from '../../../src/context/context-builder.js';

describe('ContextBuilder', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `codemoot-ctx-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('assembles prompt without context when no projectDir or memoryStore', () => {
    const builder = new ContextBuilder({});
    const result = builder.assemble('Review this code');

    expect(result.prompt).toBe('Review this code');
    expect(result.memories).toEqual([]);
    expect(result.fileTree).toBe('');
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('adds task type framing when provided', () => {
    const builder = new ContextBuilder({});
    const result = builder.assemble('Review this code', 'review');

    expect(result.prompt).toContain('[Task type: review]');
    expect(result.prompt).toContain('Review this code');
  });

  it('builds file tree from project directory', () => {
    // Create test files
    writeFileSync(join(testDir, 'index.ts'), 'export const x = 1;');
    writeFileSync(join(testDir, 'utils.ts'), 'export function foo() {}');
    mkdirSync(join(testDir, 'src'));
    writeFileSync(join(testDir, 'src', 'main.ts'), 'console.log("hi")');

    const builder = new ContextBuilder({ projectDir: testDir });
    const tree = builder.buildFileTree();

    expect(tree).toContain('index.ts');
    expect(tree).toContain('utils.ts');
    expect(tree).toContain('src/');
    expect(tree).toContain('main.ts');
  });

  it('excludes node_modules and .git from file tree', () => {
    mkdirSync(join(testDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(testDir, 'node_modules', 'pkg', 'index.js'), '');
    mkdirSync(join(testDir, '.git'), { recursive: true });
    writeFileSync(join(testDir, '.git', 'config'), '');
    writeFileSync(join(testDir, 'app.ts'), 'code');

    const builder = new ContextBuilder({ projectDir: testDir });
    const tree = builder.buildFileTree();

    expect(tree).not.toContain('node_modules');
    expect(tree).not.toContain('.git');
    expect(tree).toContain('app.ts');
  });

  it('respects maxTreeDepth', () => {
    mkdirSync(join(testDir, 'a', 'b', 'c', 'd'), { recursive: true });
    writeFileSync(join(testDir, 'a', 'b', 'c', 'd', 'deep.ts'), 'deep');
    writeFileSync(join(testDir, 'a', 'shallow.ts'), 'shallow');

    const builder = new ContextBuilder({ projectDir: testDir, maxTreeDepth: 1 });
    const tree = builder.buildFileTree();

    expect(tree).toContain('shallow.ts');
    expect(tree).not.toContain('deep.ts');
  });

  it('includes file tree in assembled prompt', () => {
    writeFileSync(join(testDir, 'index.ts'), 'code');

    const builder = new ContextBuilder({ projectDir: testDir });
    const result = builder.assemble('Review this');

    expect(result.prompt).toContain('## Project Structure');
    expect(result.prompt).toContain('index.ts');
    expect(result.prompt).toContain('Review this');
  });

  it('injects memories when memoryStore is provided', () => {
    const mockMemoryStore = {
      search: vi.fn().mockReturnValue([
        {
          id: 1,
          projectId: 'test',
          category: 'convention',
          content: 'Use ESM imports only',
          sourceSessionId: null,
          importance: 0.8,
          createdAt: '2026-01-01',
          accessedAt: '2026-01-01',
          accessCount: 0,
        },
      ]),
      recordAccess: vi.fn(),
    };

    const builder = new ContextBuilder({
      projectId: 'test',
      memoryStore: mockMemoryStore as never,
    });
    const result = builder.assemble('Review the authentication module');

    expect(result.prompt).toContain('## Project Context (from memory)');
    expect(result.prompt).toContain('Use ESM imports only');
    expect(result.memories).toHaveLength(1);
    expect(mockMemoryStore.recordAccess).toHaveBeenCalledWith(1);
  });

  it('reads file content within budget', () => {
    writeFileSync(join(testDir, 'src.ts'), 'const x = 42;\nexport default x;');

    const builder = new ContextBuilder({ projectDir: testDir });
    const content = builder.readFileContent('src.ts');

    expect(content).toBe('const x = 42;\nexport default x;');
  });

  it('truncates file content exceeding maxChars', () => {
    writeFileSync(join(testDir, 'big.ts'), 'x'.repeat(10000));

    const builder = new ContextBuilder({ projectDir: testDir });
    const content = builder.readFileContent('big.ts', 100);

    expect(content).toContain('[TRUNCATED');
    expect(content?.length).toBeLessThan(200);
  });

  it('returns null for non-existent files', () => {
    const builder = new ContextBuilder({ projectDir: testDir });
    const content = builder.readFileContent('nonexistent.ts');

    expect(content).toBeNull();
  });

  it('only includes files with known extensions', () => {
    writeFileSync(join(testDir, 'code.ts'), 'ts');
    writeFileSync(join(testDir, 'image.png'), 'binary');
    writeFileSync(join(testDir, 'data.csv'), 'a,b,c');

    const builder = new ContextBuilder({ projectDir: testDir });
    const tree = builder.buildFileTree();

    expect(tree).toContain('code.ts');
    expect(tree).not.toContain('image.png');
    expect(tree).not.toContain('data.csv');
  });

  it('estimates tokens correctly', () => {
    const builder = new ContextBuilder({});
    const result = builder.assemble('a'.repeat(400));

    // 400 chars / 4 = 100 tokens
    expect(result.estimatedTokens).toBe(100);
  });

  it('caps file tree at maxFiles', () => {
    // Create more files than the cap
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(testDir, `file${i}.ts`), `const x${i} = ${i};`);
    }

    const builder = new ContextBuilder({ projectDir: testDir, maxFiles: 5 });
    const tree = builder.buildFileTree();

    // Should contain truncation notice
    expect(tree).toContain('[... truncated at 5 files]');
    // Should have at most 5 file entries (plus the truncation notice)
    const fileLines = tree.split('\n').filter((l) => l.endsWith('.ts'));
    expect(fileLines.length).toBe(5);
  });
});

describe('buildHandoffEnvelope', () => {
  it('builds basic envelope with preamble and output contract', () => {
    const result = buildHandoffEnvelope({
      command: 'review',
      task: 'Check this file for bugs',
      resumed: false,
    });

    expect(result).toContain('full access to this project');
    expect(result).toContain('Check this file for bugs');
    expect(result).toContain('VERDICT: APPROVED or VERDICT: NEEDS_REVISION');
    expect(result).toContain('SCORE: X/10');
    expect(result).not.toContain('Continue from prior thread');
  });

  it('includes resume primer when resumed', () => {
    const result = buildHandoffEnvelope({
      command: 'review',
      task: 'Check again',
      resumed: true,
    });

    expect(result).toContain('Continue from prior thread');
    expect(result).toContain('Do not repeat completed analysis');
  });

  it('includes prior context in resume primer', () => {
    const result = buildHandoffEnvelope({
      command: 'review',
      task: 'Check again',
      resumed: true,
      priorContext: 'Found 3 bugs in auth module',
    });

    expect(result).toContain('Found 3 bugs in auth module');
  });

  it('includes constraints', () => {
    const result = buildHandoffEnvelope({
      command: 'review',
      task: 'Review code',
      resumed: false,
      constraints: ['Focus on security', 'Ignore test files'],
    });

    expect(result).toContain('CONSTRAINTS:');
    expect(result).toContain('- Focus on security');
    expect(result).toContain('- Ignore test files');
  });

  it('includes scope restriction', () => {
    const result = buildHandoffEnvelope({
      command: 'review',
      task: 'Review code',
      resumed: false,
      scope: 'src/**/*.ts',
    });

    expect(result).toContain('Restrict exploration to files matching: src/**/*.ts');
  });

  it('uses cleanup output contract', () => {
    const result = buildHandoffEnvelope({
      command: 'cleanup',
      task: 'Scan for issues',
      resumed: false,
    });

    expect(result).toContain('FINDING:');
    expect(result).toContain('SCAN_COMPLETE');
    expect(result).not.toContain('VERDICT');
  });

  it('uses adjudicate output contract', () => {
    const result = buildHandoffEnvelope({
      command: 'adjudicate',
      task: 'Verify finding',
      resumed: false,
    });

    expect(result).toContain('ADJUDICATE: CONFIRMED|DISMISSED|UNCERTAIN');
  });

  it('custom command has no output contract', () => {
    const result = buildHandoffEnvelope({
      command: 'custom',
      task: 'Do something',
      resumed: false,
    });

    expect(result).toContain('Do something');
    expect(result).not.toContain('VERDICT');
    expect(result).not.toContain('FINDING');
  });
});
