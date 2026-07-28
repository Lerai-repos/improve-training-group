import { describe, expect, it } from 'vitest';

import { normalizeAddressKey } from '../travel-cache';

describe('normalizeAddressKey', () => {
  it('lowercases, collapses whitespace, trims, NFC-normalizes', () => {
    expect(normalizeAddressKey('  Wolvenplein   25,  Utrecht ')).toBe('wolvenplein 25, utrecht');
    expect(normalizeAddressKey('CAFÉ\tX')).toBe('café x');
  });

  it('equal addresses that differ only in spacing/case map to the same key', () => {
    expect(normalizeAddressKey('Raadhuisplein 1')).toBe(normalizeAddressKey('raadhuisplein  1'));
  });
});
