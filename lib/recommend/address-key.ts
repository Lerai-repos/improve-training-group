import { createHmac } from 'node:crypto';

/**
 * A KEYED (HMAC-SHA256) fingerprint of a normalized address. Used both as the
 * travel_cache row key and as the audit-artifact fingerprint, so no raw address is
 * ever persisted. A plain SHA-256 would be dictionary-recoverable for common
 * addresses; the HMAC secret defeats that. The key is resolved lazily (not at
 * module load) so `next build` — which never calls this — can't fail on a missing
 * secret; a production runtime WITHOUT the secret throws (surfaced as FOUT).
 */

const FALLBACK_KEY = 'dev-only-insecure-address-hash-key';
const KEY_LENGTH = 16;
const MIN_KEY_LENGTH = 16;

let cachedKey: string | null = null;

function hashKey(): string {
  if (cachedKey !== null) {
    return cachedKey;
  }
  const configured = process.env.ADDRESS_HASH_KEY;
  if (configured) {
    if (configured.length < MIN_KEY_LENGTH) {
      throw new Error(`ADDRESS_HASH_KEY must be at least ${MIN_KEY_LENGTH} characters`);
    }
    cachedKey = configured;
    return cachedKey;
  }
  const isProduction =
    process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  if (isProduction) {
    throw new Error('ADDRESS_HASH_KEY is required in production (keyed address fingerprints)');
  }
  cachedKey = FALLBACK_KEY;
  return cachedKey;
}

export function addressKey(norm: string): string {
  return createHmac('sha256', hashKey()).update(norm).digest('hex').slice(0, KEY_LENGTH);
}

/**
 * Fail-fast validation for worker startup: resolves (and caches) the key so a
 * missing/short `ADDRESS_HASH_KEY` in production fails at dependency-build time
 * rather than at the first physical-location run's travel stage.
 */
export function assertAddressHashKey(): void {
  hashKey();
}
