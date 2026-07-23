import { config as loadEnv } from 'dotenv';

// Integration tests run under Vitest (not Next), so .env.local isn't auto-loaded.
// Load it before any test reads Supabase env.
loadEnv({ path: '.env.local' });
