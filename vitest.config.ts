import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/cli', 'packages/mcp-server'],
    passWithNoTests: true,
  },
});
