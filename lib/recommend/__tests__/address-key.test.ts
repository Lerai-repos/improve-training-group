import { describe, expect, it } from 'vitest';

import { addressKey } from '../address-key';

describe('addressKey', () => {
  it('is deterministic and never returns the raw address', () => {
    const norm = 'kerkstraat 1 utrecht';
    const key = addressKey(norm);
    expect(key).toBe(addressKey(norm)); // stable
    expect(key).not.toContain('kerkstraat'); // no raw address
    expect(key).toMatch(/^[0-9a-f]{16}$/); // keyed hex digest
  });

  it('distinguishes different addresses', () => {
    expect(addressKey('a straat 1')).not.toBe(addressKey('b straat 2'));
  });
});
