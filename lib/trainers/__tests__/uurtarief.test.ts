import { describe, expect, it } from 'vitest';

import { centsToEuros, parseUurtarief, MAX_HOURLY_EUROS, MIN_HOURLY_EUROS } from '../uurtarief';

describe('parseUurtarief', () => {
  it('treats an absent, null or blank cell as no override', () => {
    for (const raw of [undefined, null, '', '   ']) {
      expect(parseUurtarief(raw)).toEqual({ kind: 'none' });
    }
  });

  it('reads a whole and a decimal amount into cents', () => {
    expect(parseUurtarief('88')).toEqual({ kind: 'cents', cents: 8800 });
    expect(parseUurtarief('84.50')).toEqual({ kind: 'cents', cents: 8450 });
    expect(parseUurtarief(' 84,05 ')).toEqual({ kind: 'cents', cents: 8405 });
  });

  it('never rounds through a float', () => {
    // Number('84.10') * 100 is 8409.999999999998; the digit parser must not be.
    expect(parseUurtarief('84.10')).toEqual({ kind: 'cents', cents: 8410 });
    expect(parseUurtarief('0.29')).toMatchObject({ kind: 'invalid' }); // below the floor
  });

  it('refuses a dagdeel amount typed into an hourly column', () => {
    // The board really carries "500 euro per dagdeel trainer" today. Priced hourly that
    // is roughly six times the real cost and looks entirely ordinary in the popup.
    const result = parseUurtarief('500');
    expect(result.kind).toBe('invalid');
    expect(result.kind === 'invalid' && result.reason).toContain('UURtarief');
  });

  it('refuses an implausibly low amount as firmly as a high one', () => {
    expect(parseUurtarief(String(MIN_HOURLY_EUROS - 1)).kind).toBe('invalid');
    expect(parseUurtarief(String(MAX_HOURLY_EUROS + 1)).kind).toBe('invalid');
    expect(parseUurtarief(String(MIN_HOURLY_EUROS)).kind).toBe('cents');
    expect(parseUurtarief(String(MAX_HOURLY_EUROS)).kind).toBe('cents');
  });

  it('refuses what is not a plain decimal, and never throws', () => {
    for (const raw of ['abc', '1e3', '88 euro', '€88', '1.234', '-88', '+88', '1,000.00']) {
      expect(() => parseUurtarief(raw)).not.toThrow();
      expect(parseUurtarief(raw).kind).toBe('invalid');
    }
  });

  it('keeps the raw text on a refusal so the operator can find the cell', () => {
    const result = parseUurtarief('500');
    expect(result.kind === 'invalid' && result.raw).toBe('500');
  });
});

describe('centsToEuros', () => {
  it('round-trips through the parser', () => {
    for (const cents of [2000, 8400, 8800, 8450, 8405, 25000]) {
      expect(parseUurtarief(centsToEuros(cents))).toEqual({ kind: 'cents', cents });
    }
  });

  it('drops the decimals on a whole amount and keeps both otherwise', () => {
    expect(centsToEuros(8800)).toBe('88');
    expect(centsToEuros(8450)).toBe('84.50');
    // padStart, not padEnd: five cents is 0.05, not 0.50.
    expect(centsToEuros(8405)).toBe('84.05');
  });

  it('refuses a non-integer, rather than writing a float onto the board', () => {
    expect(() => centsToEuros(84.5)).toThrow(/geheel/);
  });
});
