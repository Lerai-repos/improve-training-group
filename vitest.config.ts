import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Two projects, one command.
 *
 * `pnpm test:unit` runs BOTH. That is the point of using projects rather than a second
 * runner: a component test in a directory no config mentions does not fail, it simply
 * never executes — and nothing about a green run says otherwise. One entry point means
 * no verification command can silently omit half the suite.
 *
 * - **unit** — pure functions and in-memory adapters, `node`. No database, no Docker, no
 *   network. The Docker-backed integration project is gone with Supabase; what it used
 *   to cover is now either a unit test against an in-memory store or a live check in the
 *   runbook (docs/m2b/README.md §7).
 * - **components** — the Monday item view, `jsdom`. Its behaviours (context change,
 *   token refresh on 401, restricted vs full rendering, read-only controls) are
 *   component-level; an e2e test would have to drive a real Monday iframe, which is not
 *   automatable here.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['lib/calc/**', 'lib/config/**', 'lib/monday/**'],
    },
    projects: [
      {
        plugins: [tsconfigPaths()],
        test: {
          name: 'unit',
          environment: 'node',
          include: ['lib/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'lib/**/*.integration.test.ts'],
        },
      },
      {
        plugins: [tsconfigPaths(), react()],
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['components/**/*.test.tsx'],
          exclude: ['**/node_modules/**'],
        },
      },
    ],
  },
});
