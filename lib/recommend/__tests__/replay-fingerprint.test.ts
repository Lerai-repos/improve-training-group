import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { addressKey } from '../address-key';
import { normalizeAddressKey } from '../travel-cache';

/**
 * `scripts/sanitize-replay.ts` reimplements the address fingerprint so it can hash
 * under two different keys in one process (`address-key.ts` caches its key at
 * first use). That duplication is deliberate but dangerous: if the real algorithm
 * changes and the sanitizer's copy does not, every committed replay fixture
 * silently encodes the wrong fingerprints and the equivalence check starts
 * comparing nonsense. This pins them together.
 */
function sanitizerFingerprint(key: string, address: string): string {
  return createHmac('sha256', key).update(normalizeAddressKey(address)).digest('hex').slice(0, 16);
}

describe('replay fixture fingerprinting', () => {
  it("matches address-key.ts's addressKey for the same key and address", () => {
    // The dev fallback key is what addressKey() uses when ADDRESS_HASH_KEY is unset,
    // which is the case under vitest.
    const FALLBACK = 'dev-only-insecure-address-hash-key';
    expect(process.env.ADDRESS_HASH_KEY).toBeUndefined();

    for (const address of [
      'Wolvenplein 25, Utrecht',
      'Teststraat 1, 1000 AA Voorbeeldstad',
      '  MIXED   Case  Street 9  ',
      'Straße 5, Köln',
    ]) {
      expect(sanitizerFingerprint(FALLBACK, address)).toBe(
        addressKey(normalizeAddressKey(address))
      );
    }
  });

  it('produces a different fingerprint under a different key', () => {
    const a = sanitizerFingerprint('key-one-at-least-16-chars', 'Teststraat 1');
    const b = sanitizerFingerprint('key-two-at-least-16-chars', 'Teststraat 1');
    expect(a).not.toBe(b);
    expect(a).toHaveLength(16);
  });

  it('is stable for the same key and address (replay depends on this)', () => {
    const k = 'replay-fixture-address-hash-key-v1';
    expect(sanitizerFingerprint(k, 'Teststraat 3, 1002 CC Voorbeeldstad')).toBe(
      sanitizerFingerprint(k, 'Teststraat 3, 1002 CC Voorbeeldstad')
    );
  });
});
