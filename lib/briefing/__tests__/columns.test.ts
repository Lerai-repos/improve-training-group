import { describe, expect, it } from 'vitest';

import { formatAccountmanager, formatContact, formatDutchMobile } from '../columns';

describe('formatDutchMobile', () => {
  /** All four shapes are real values read off ITG's boards on 19-Aug-2026. */
  it('normalises every format the boards actually contain', () => {
    expect(formatDutchMobile('+31 6 36331302')).toBe('06-36331302');
    expect(formatDutchMobile('+31648431025')).toBe('06-48431025');
    expect(formatDutchMobile('+31(0) 6 57836652')).toBe('06-57836652');
    expect(formatDutchMobile('06-42084295')).toBe('06-42084295');
    expect(formatDutchMobile('0642084295')).toBe('06-42084295');
  });

  /**
   * A number we cannot parse comes back untouched. Half-normalising a landline or a
   * foreign number would produce something that looks dialable and is not.
   */
  it('returns anything unrecognised unchanged', () => {
    expect(formatDutchMobile('030-2273623')).toBe('030-2273623');
    expect(formatDutchMobile('+49 151 12345678')).toBe('+49 151 12345678');
    expect(formatDutchMobile('doorkiesnummer volgt')).toBe('doorkiesnummer volgt');
    expect(formatDutchMobile('')).toBe('');
    expect(formatDutchMobile(null)).toBe('');
  });
});

describe('formatContact', () => {
  it('matches the v2.0 briefing', () => {
    expect(formatContact('Paula Hollander', '+31 6 42085076')).toBe(
      'Paula Hollander (06-42085076)'
    );
  });

  /** Roughly half the contacts have no number, so this is the common case, not an edge. */
  it('drops the brackets rather than printing an empty pair', () => {
    expect(formatContact('Paula Hollander', '')).toBe('Paula Hollander');
    expect(formatContact('Paula Hollander', null as unknown as string)).toBe('Paula Hollander');
  });

  it('is empty when there is no name at all', () => {
    expect(formatContact('', '+31 6 42085076')).toBe('');
  });
});

describe('formatAccountmanager', () => {
  it('matches the v2.0 briefing', () => {
    expect(formatAccountmanager('Dirkje Pril', '+31648431025')).toBe('Dirkje Pril / 06-48431025');
  });

  it('falls back to the name alone', () => {
    expect(formatAccountmanager('Dirkje Pril', '')).toBe('Dirkje Pril');
  });
});
