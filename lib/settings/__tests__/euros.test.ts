import { describe, expect, it } from 'vitest';

import { eurosToCents } from '../euros';

/**
 * The board speaks euros because that is what ITG types; the engine speaks cents
 * because money in floats is how a rounding error becomes a price. This module is the
 * only crossing, so its edge cases are the ones that matter.
 */
describe('eurosToCents', () => {
  it('accepts both decimal separators — the board is Dutch, the seed data is not', () => {
    expect(eurosToCents('0.23')).toBe(23);
    expect(eurosToCents('0,23')).toBe(23);
  });

  it('treats a bare integer as whole euros', () => {
    expect(eurosToCents('1')).toBe(100);
    expect(eurosToCents('88')).toBe(8800);
  });

  /**
   * The reason this parser is digit-based rather than `Number(v) * 100`.
   * `Number('0.29') * 100` is 28.999999999999996, and `84.10` is the shape every
   * hourly rate takes. A float round-trip here silently misprices a training.
   */
  it('does not lose a cent to floating point', () => {
    expect(eurosToCents('0.29')).toBe(29);
    expect(eurosToCents('84.10')).toBe(8410);
    expect(eurosToCents('0.07')).toBe(7);
    expect(eurosToCents('1.10')).toBe(110);
  });

  it('pads a single decimal place', () => {
    expect(eurosToCents('0.5')).toBe(50);
    expect(eurosToCents('1,5')).toBe(150);
  });

  it('accepts a deliberate zero', () => {
    expect(eurosToCents('0')).toBe(0);
    expect(eurosToCents('0.00')).toBe(0);
  });

  it('tolerates surrounding whitespace', () => {
    expect(eurosToCents('  0.23  ')).toBe(23);
  });

  /**
   * Blank is NOT zero. A cleared travel rate must not read as "travel is free" — the
   * same rule `asNumber` already applies in the config layer, for the same reason.
   */
  it('rejects blank and whitespace-only', () => {
    expect(() => eurosToCents('')).toThrow();
    expect(() => eurosToCents('   ')).toThrow();
  });

  it('rejects anything that is not a plain decimal number', () => {
    expect(() => eurosToCents('abc')).toThrow();
    expect(() => eurosToCents('€0.23')).toThrow();
    expect(() => eurosToCents('0.23 per km')).toThrow();
  });

  /**
   * `Number('1e3')` is 1000 — so a permissive parser would read `1e3` as €1000/km
   * without complaint. Exponent notation is never a thing anyone types into a price.
   */
  it('rejects exponent notation', () => {
    expect(() => eurosToCents('1e3')).toThrow();
    expect(() => eurosToCents('1E3')).toThrow();
  });

  it('rejects negatives — there is no negative tariff', () => {
    expect(() => eurosToCents('-1')).toThrow();
    expect(() => eurosToCents('-0.23')).toThrow();
  });

  /**
   * Rounding a third decimal silently is the one thing a money parser must not do:
   * it turns a typo into a plausible price. Refuse and let a human look.
   */
  it('rejects more than two decimals rather than rounding', () => {
    expect(() => eurosToCents('0.235')).toThrow();
    expect(() => eurosToCents('0,235')).toThrow();
  });

  it('rejects mixed or repeated separators', () => {
    expect(() => eurosToCents('1,2.3')).toThrow();
    expect(() => eurosToCents('1.2.3')).toThrow();
    expect(() => eurosToCents('1,234,567')).toThrow();
  });

  it('names the offending value, so a board row can be found', () => {
    expect(() => eurosToCents('0.235')).toThrow(/0\.235/);
  });
});
