import { describe, expect, it } from 'vitest';

import { formatDeadline, materialsDeadline, parseStartTime, workingDaysBefore } from '../deadline';

describe('materialsDeadline', () => {
  /**
   * The only worked example ITG has given us, from the v2.0 briefing: a training on
   * Tuesday 24 March 2026 at 09:30 has its materials due Thursday 19 March at 09:30.
   * If this test ever fails, the rule changed, not the code.
   */
  it("reproduces Dirkje's own example", () => {
    const out = materialsDeadline({ datum: '2026-03-24', tijden: '09:30 - 12:30' });
    expect(out).toEqual({ date: '2026-03-19', time: '09:30' });
    expect(formatDeadline(out)).toBe('19 maart 2026; 09:30 uur');
  });

  it('skips the weekend rather than counting it', () => {
    // Wednesday back three working days is Friday, not Sunday.
    expect(materialsDeadline({ datum: '2026-03-25', tijden: '10:00' })?.date).toBe('2026-03-20');
    // A Monday training reaches back past two weekends' worth of nothing.
    expect(materialsDeadline({ datum: '2026-03-23', tijden: '10:00' })?.date).toBe('2026-03-18');
  });

  it('never lands the deadline on a weekend day', () => {
    for (let day = 1; day <= 28; day += 1) {
      const datum = `2026-09-${String(day).padStart(2, '0')}`;
      const out = materialsDeadline({ datum, tijden: '09:00' });
      const weekday = new Date(`${out!.date}T00:00:00Z`).getUTCDay();
      expect([0, 6]).not.toContain(weekday);
    }
  });

  /**
   * A missing date must not produce a plausible-looking deadline. An empty row is honest;
   * a date computed from nothing is the kind of wrong that nobody notices.
   */
  it('returns null for an unusable date', () => {
    expect(materialsDeadline({ datum: '', tijden: '09:30' })).toBeNull();
    expect(materialsDeadline({ datum: null, tijden: '09:30' })).toBeNull();
    expect(materialsDeadline({ datum: '24-03-2026', tijden: '09:30' })).toBeNull();
    expect(formatDeadline(null)).toBe('');
  });

  /**
   * `2026-02-30` matches the shape and JavaScript rolls it silently forward to 2 March
   * rather than producing NaN, so a naive check yields a tidy deadline of 25 February for
   * a day that does not exist.
   */
  it('rejects calendar dates that do not exist', () => {
    expect(materialsDeadline({ datum: '2026-02-30', tijden: '09:30' })).toBeNull();
    expect(materialsDeadline({ datum: '2026-13-01', tijden: '09:30' })).toBeNull();
    expect(materialsDeadline({ datum: '2026-04-31', tijden: '09:30' })).toBeNull();
    // 2028 is a leap year, 2026 is not.
    expect(materialsDeadline({ datum: '2026-02-29', tijden: '09:30' })).toBeNull();
    expect(materialsDeadline({ datum: '2028-02-29', tijden: '09:30' })?.date).toBe('2028-02-24');
  });

  it('keeps the date when the time is unreadable, without inventing midnight', () => {
    const out = materialsDeadline({ datum: '2026-03-24', tijden: 'in overleg' });
    expect(out).toEqual({ date: '2026-03-19', time: '' });
    expect(formatDeadline(out)).toBe('19 maart 2026');
  });

  it('does not shift the clock across a daylight-saving boundary', () => {
    // Dutch summer time starts 29 March 2026. A local-time implementation moves 09:30
    // to 08:30 or 10:30 here; UTC day-stepping does not.
    expect(materialsDeadline({ datum: '2026-03-31', tijden: '09:30' })).toEqual({
      date: '2026-03-26',
      time: '09:30',
    });
  });
});

describe('parseStartTime', () => {
  it('takes the first time from the real formats on the board', () => {
    expect(parseStartTime('09:30 - 12:30')).toBe('09:30');
    expect(parseStartTime('9:30-12:30')).toBe('09:30');
    expect(parseStartTime('13.00 tot 16.00')).toBe('13:00');
    expect(parseStartTime('09:30')).toBe('09:30');
  });

  it('refuses nonsense instead of guessing', () => {
    expect(parseStartTime('nader te bepalen')).toBeNull();
    expect(parseStartTime('')).toBeNull();
    expect(parseStartTime(null)).toBeNull();
    expect(parseStartTime('99:99')).toBeNull();
  });
});

describe('workingDaysBefore', () => {
  it('counts working days, not calendar days', () => {
    const friday = new Date('2026-03-27T09:30:00Z');
    expect(workingDaysBefore(friday, 3).toISOString().slice(0, 10)).toBe('2026-03-24');
    expect(workingDaysBefore(friday, 5).toISOString().slice(0, 10)).toBe('2026-03-20');
  });

  it('preserves the time of day', () => {
    const at = new Date('2026-03-24T09:30:00Z');
    expect(workingDaysBefore(at, 3).toISOString()).toContain('T09:30:00');
  });
});
