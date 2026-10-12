import { describe, expect, it } from 'vitest';

import { herstelAlineas } from '../alineas';

describe('herstelAlineas', () => {
  /** Zo levert Monday een enter in een lang tekstveld: twee spaties. */
  it('maakt van twee spaties na een zin een nieuwe alinea', () => {
    expect(herstelAlineas('Eerste alinea.  Tweede alinea.   Derde.')).toBe(
      'Eerste alinea.\nTweede alinea.\nDerde.'
    );
  });

  it('maakt ook van een enter na een kopje een nieuwe alinea', () => {
    expect(herstelAlineas('Aanleiding  Binnen het team')).toBe('Aanleiding\nBinnen het team');
  });

  /** Gemeten: de enige keer twee spaties zonder enter, midden in een zin. */
  it('laat twee spaties vóór een kleine letter staan als één zin', () => {
    expect(herstelAlineas('de ochtend is ongeveer 2  beschikbaar om')).toBe(
      'de ochtend is ongeveer 2  beschikbaar om'
    );
  });

  it('laat echte regeleinden staan en gooit lege regels weg', () => {
    expect(herstelAlineas('Een.\n\n Twee.  Drie.\n')).toBe('Een.\nTwee.\nDrie.');
  });

  it('laat een kopje met één spatie vast aan de zin erna', () => {
    expect(herstelAlineas('Aanleiding Binnen het team')).toBe('Aanleiding Binnen het team');
  });

  it('laat een lege tekst leeg', () => {
    expect(herstelAlineas('   ')).toBe('');
  });
});
