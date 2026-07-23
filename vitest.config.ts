import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Unit tests: pure functions only, no database, no Docker.
// Integration tests (Docker-dependent Supabase) live in *.integration.test.ts
// and run via vitest.integration.config.ts.
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
