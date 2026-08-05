import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Unit tests: pure functions and in-memory adapters. No database, no Docker, no
// network. The Docker-backed integration project is gone with Supabase; what it used
// to cover is now either a unit test against an in-memory store or a live check in
// the runbook (docs/m2b/README.md §7).
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'lib/**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['lib/calc/**', 'lib/config/**', 'lib/monday/**'],
    },
  },
});
