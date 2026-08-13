import { describe, expect, it } from 'vitest';

import { normaliseName, resolveSetting } from '../keys';

describe('normaliseName', () => {
  /**
   * The item name IS the key, and it is typed by hand on a board anyone can edit. A
   * stray double space or an underscore pasted from an env var must not read as a
   * different — i.e. absent — setting, because absent has a meaning of its own.
   */
  it('folds case, separators and repeated whitespace', () => {
    const expected = normaliseName('HQ ADRES');
    expect(normaliseName('hq adres')).toBe(expected);
    expect(normaliseName('HQ_ADRES')).toBe(expected);
    expect(normaliseName('HQ-ADRES')).toBe(expected);
    expect(normaliseName('  HQ   ADRES  ')).toBe(expected);
  });

  it('keeps genuinely different names apart', () => {
    expect(normaliseName('REISTARIEF TRAINERS')).not.toBe(normaliseName('REISTARIEF HQ'));
  });
});

describe('resolveSetting', () => {
  it('maps the Dutch names to their config keys, converting euros to cents', () => {
    expect(resolveSetting('HQ ADRES', 'Wolvenplein 25, Utrecht')).toEqual({
      kind: 'app',
      row: { key: 'HQ_ADRES', value: 'Wolvenplein 25, Utrecht' },
    });
    expect(resolveSetting('REISTARIEF TRAINERS', '0.23')).toEqual({
      kind: 'app',
      row: { key: 'TRAVEL_RATE_TRAINER_CENTS_PER_KM', value: '23' },
    });
    expect(resolveSetting('REISTARIEF HQ', '0.45')).toEqual({
      kind: 'app',
      row: { key: 'TRAVEL_RATE_CLIENT_CENTS_PER_KM', value: '45' },
    });
    expect(resolveSetting('REISTIJD VERGOEDING', '1')).toEqual({
      kind: 'app',
      row: { key: 'TRAVEL_TIME_FEE_PER_MINUTE_CENTS', value: '100' },
    });
  });

  /** Minutes are minutes — the one numeric row that is NOT money. */
  it('reads the reistijd threshold as whole minutes, not euros', () => {
    expect(resolveSetting('REISTIJD DREMPEL', '90')).toEqual({
      kind: 'app',
      row: { key: 'TRAVEL_TIME_THRESHOLD_MINUTES', value: '90' },
    });
    expect(() => resolveSetting('REISTIJD DREMPEL', '90.5')).toThrow();
    expect(() => resolveSetting('REISTIJD DREMPEL', '')).toThrow();
  });

  it('classifies the tariff rows separately — they are rate cards, not app config', () => {
    expect(resolveSetting('TARIEF 2020 - 2024', '88')).toEqual({
      kind: 'rate',
      rateKey: '2020-2024',
      hourlyRateCents: 8800,
    });
    expect(resolveSetting('TARIEF 2024 - HEDEN', '84')).toEqual({
      kind: 'rate',
      rateKey: '2024-heden',
      hourlyRateCents: 8400,
    });
  });

  /**
   * The board is created with Dutch names, but `Configurarie` used two English ones.
   * A row recreated by hand from the old table should resolve rather than take the
   * whole config down as an unknown name.
   */
  it('accepts the legacy Airtable spellings as aliases', () => {
    expect(resolveSetting('TRAVEL TIME THRESHOLD', '90')).toEqual(
      resolveSetting('REISTIJD DREMPEL', '90')
    );
    expect(resolveSetting('TRAVEL TIME FEE', '1')).toEqual(
      resolveSetting('REISTIJD VERGOEDING', '1')
    );
  });

  it('returns unknown for a name it does not recognise, rather than throwing here', () => {
    // The caller decides: fatal outside `Notities`, ignored inside it. Throwing at this
    // level would remove that choice and make every note a config outage.
    expect(resolveSetting('EEN LOSSE NOTITIE', 'wat tekst')).toEqual({ kind: 'unknown' });
  });

  it('still rejects a malformed value on a name it DOES recognise', () => {
    expect(() => resolveSetting('REISTARIEF TRAINERS', 'abc')).toThrow();
    expect(() => resolveSetting('TARIEF 2020 - 2024', '')).toThrow();
  });
});
