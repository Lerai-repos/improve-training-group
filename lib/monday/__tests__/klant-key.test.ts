import { describe, expect, it } from 'vitest';

import { findAliasCandidates, klantFingerprint, klantIdentityKey } from '../klant-key';

describe('klantIdentityKey', () => {
  it('trims and collapses whitespace', () => {
    expect(klantIdentityKey('  Acme   BV ')).toBe('Acme BV');
  });

  it('does NOT strip (copy) or fold case (those are merge decisions)', () => {
    expect(klantIdentityKey('De Heus (copy)')).toBe('De Heus (copy)');
    expect(klantIdentityKey('Repair Care')).toBe('Repair Care');
  });

  it('returns empty string for null/empty', () => {
    expect(klantIdentityKey(null)).toBe('');
    expect(klantIdentityKey('   ')).toBe('');
  });
});

describe('klantFingerprint', () => {
  it('lowercases and strips trailing (copy) groups', () => {
    expect(klantFingerprint('De Heus (copy) (copy)')).toBe('de heus');
    expect(klantFingerprint('Repair care')).toBe('repair care');
  });

  it('collapses De Heus and De Heus (copy) to the same fingerprint', () => {
    expect(klantFingerprint('De Heus')).toBe(klantFingerprint('De Heus (copy)'));
  });
});

describe('findAliasCandidates', () => {
  it('flags distinct identity keys that share a fingerprint', () => {
    const candidates = findAliasCandidates([
      'De Heus',
      'De Heus (copy)',
      'Repair Care',
      'Repair care',
      'Acme BV',
    ]);
    const fingerprints = candidates.map((c) => c.fingerprint);
    expect(fingerprints).toContain('de heus');
    expect(fingerprints).toContain('repair care');
    // Acme BV is unique — not a candidate.
    expect(fingerprints).not.toContain('acme bv');
  });

  it('does not flag a single key repeated', () => {
    expect(findAliasCandidates(['Acme BV', 'Acme BV', 'Acme BV'])).toEqual([]);
  });

  it('ignores empty names', () => {
    expect(findAliasCandidates([null, '', '   '])).toEqual([]);
  });
});
