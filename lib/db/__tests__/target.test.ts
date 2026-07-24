import { describe, expect, it } from 'vitest';

import { assertNonProdTarget, isLocalDbUrl } from '../target';

describe('isLocalDbUrl', () => {
  it('accepts localhost / 127.0.0.1 (strict hostname, not substring)', () => {
    expect(isLocalDbUrl('http://127.0.0.1:54321')).toBe(true);
    expect(isLocalDbUrl('http://localhost:54321')).toBe(true);
  });

  it('rejects hosted URLs — including ones that merely contain "localhost"', () => {
    expect(isLocalDbUrl('https://abcd.supabase.co')).toBe(false);
    // A hostname trick: "localhost" as a subdomain of an evil host must NOT pass.
    expect(isLocalDbUrl('https://localhost.evil.com')).toBe(false);
    expect(isLocalDbUrl('not a url')).toBe(false);
  });
});

describe('assertNonProdTarget', () => {
  it('passes for a local target', () => {
    expect(() => assertNonProdTarget('http://127.0.0.1:54321')).not.toThrow();
  });
  it('throws for a hosted target', () => {
    expect(() => assertNonProdTarget('https://abcd.supabase.co')).toThrow(/non-local/);
  });
});
