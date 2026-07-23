import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Integration tests: require a running local Supabase (Docker).
// Run with `pnpm test:integration` after `supabase start`.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['lib/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**'],
    setupFiles: ['./vitest.setup.integration.ts'],
    // Integration tests touch a shared DB — no parallelism across files.
    fileParallelism: false,
  },
});
