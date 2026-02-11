# Contributing to CodeMoot

Thanks for your interest in contributing! CodeMoot is an open-source multi-model collaboration tool, and we welcome contributions of all kinds — bug fixes, new scanners, CLI improvements, documentation, and more.

## Prerequisites

- **Node.js >= 22**
- **pnpm >= 9** (`npm install -g pnpm`)
- **[Claude Code](https://docs.anthropic.com/en/docs/build-with-claude/claude-code)** (for testing end-to-end)
- **[Codex CLI](https://github.com/openai/codex)** (for testing end-to-end)

## Getting Started

```bash
# Clone and install
git clone https://github.com/katarmal-ram/codemoot.git
cd codemoot
pnpm install

# Build all packages
pnpm build

# Run the full test suite (628 tests across 47 files)
pnpm test

# Type checking
pnpm typecheck

# Linting (Biome)
pnpm lint
```

## Project Structure

```
packages/
  core/           # Orchestration engine, memory, models, scanners, policy
    src/
      cleanup/    # 8 scanner scopes + 3-way merge + adjudication
      config/     # Config loading, schema, presets, .codemootignore
      context/    # Handoff envelope builder
      engine/     # EventBus, StepRunner, LoopController
      memory/     # SQLite stores (sessions, debates, builds, jobs, cache)
      models/     # CliAdapter (Codex bridge), ModelRegistry, fallback
      roles/      # Role manager (architect, reviewer)
      security/   # DLP pipeline, canonical retry
      types/      # TypeScript interfaces
      utils/      # Constants, helpers
  cli/            # CLI commands (Commander.js)
    src/
      commands/   # All command handlers (review, debate, build, cleanup, etc.)
      watch/      # File watcher + coalescing debouncer
  mcp-server/     # MCP server for IDE integration (experimental)
presets/          # Built-in configuration presets
workflows/        # Workflow YAML definitions
```

## Development Workflow

1. **Fork and branch** from `master`
2. **Write tests** for new features or bug fixes
3. **Run the full suite** before submitting:
   ```bash
   pnpm build && pnpm typecheck && pnpm test && pnpm lint
   ```
4. **Keep PRs focused** — one feature or fix per PR
5. **Follow existing patterns** — look at similar code in the codebase

## Code Style

- **TypeScript strict mode**, ESM only (no `require()`)
- **Biome** for formatting and linting (`pnpm lint`, `pnpm lint:fix`)
- No `any` types — use proper generics or `unknown`
- Prefer named constants over magic numbers (see `packages/core/src/utils/constants.ts`)
- Tests use **Vitest** — always run from the monorepo root, not package directories
- No `delete` operator (Biome rule) — use `= ''` or `= undefined` for cleanup
- No unnecessary template literals (Biome rule) — use plain strings when no interpolation

## Commit Messages

Follow [conventional commits](https://www.conventionalcommits.org/):

```
feat: add new review preset for accessibility
fix: handle empty diff in review command
refactor: extract shared sleep utility
docs: update MCP server configuration guide
test: add edge case tests for token budget overflow
```

## Testing

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run specific package tests
pnpm --filter @codemoot/core test
pnpm --filter @codemoot/cli test
pnpm --filter @codemoot/mcp-server test

# Run a specific test file
pnpm test -- packages/core/tests/unit/memory/session.test.ts
```

Test locations:
- Core unit tests: `packages/core/tests/unit/`
- Core integration tests: `packages/core/tests/integration/`
- CLI tests: `packages/cli/tests/`
- MCP tests: `packages/mcp-server/tests/`

## Adding a New Cleanup Scanner Scope

1. Define the scope in `packages/core/src/types/cleanup.ts` (add to `CleanupScope` union)
2. Create `scan<Name>()` in `packages/core/src/cleanup/scanners.ts`
3. Add to `runAllScanners()` and `ALL_SCOPES` array
4. Export from `packages/core/src/cleanup/index.ts` and `packages/core/src/index.ts`
5. Add to CLI choices in `packages/cli/src/index.ts` and `packages/cli/src/commands/cleanup.ts`
6. Update `packages/cli/tests/cleanup-command.test.ts` scope arrays
7. Write tests

## Adding a New CLI Command

1. Create handler in `packages/cli/src/commands/<name>.ts`
2. Register in `packages/cli/src/index.ts`
3. Use `withDatabase()` helper from `packages/cli/src/utils.ts` for guaranteed db.close()
4. Write tests in `packages/cli/tests/<name>-command.test.ts`

## Adding a New Model CLI

CodeMoot is designed to support multiple AI CLIs. To add a new one:

1. Create a new adapter in `packages/core/src/models/` implementing the `CliBridge` interface
2. Register the provider in `ModelRegistry`
3. Add provider type to `ModelProvider` union in `packages/core/src/types/config.ts`

## Reporting Issues

- Use [GitHub Issues](https://github.com/katarmal-ram/codemoot/issues) for bugs and feature requests
- Include: steps to reproduce, expected vs actual behavior, OS/Node version
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
