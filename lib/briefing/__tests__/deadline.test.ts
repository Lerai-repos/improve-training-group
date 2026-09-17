import { describe, expect, it } from 'vitest';

import { formatDeadline, materialsDeadline, workingDaysBefore } from '../deadline';

describe('materialsDeadline', () => {
  /**
   * Dirkje, 17-Sep-2026: three working days before the training, always at 09:00 — not at
   * the training's own start time. A training on Tuesday 24 March 2026 is due Thursday
   * 19 March at 09:00.
   */
  it('lands three working days earlier at 09:00, whatever time the training starts', () => {
    const out = materialsDeadline({ datum: '2026-03-24' });
    expect(out).toEqual({ date: '2026-03-19', time: '09:00' });
    expect(formatDeadline(out)).toBe('19 maart 2026; 09:00 uur');
  });

  it('skips the weekend rather than counting it', () => {
    // Wednesday back three working days is Friday, not Sunday.
    expect(materialsDeadline({ datum: '2026-03-25' })?.date).toBe('2026-03-20');
    // A Monday training reaches back past two weekends' worth of nothing.
    expect(materialsDeadline({ datum: '2026-03-23' })?.date).toBe('2026-03-18');
  });

  it('never lands the deadline on a weekend day', () => {
    for (let day = 1; day <= 28; day += 1) {
      const datum = `2026-09-${String(day).padStart(2, '0')}`;
      const out = materialsDeadline({ datum });
      const weekday = new Date(`${out!.date}T00:00:00Z`).getUTCDay();
      expect([0, 6]).not.toContain(weekday);
    }
  });

  /**
   * A missing date must not produce a plausible-looking deadline. An empty row is honest;
   * a date computed from nothing is the kind of wrong that nobody notices.
   */
  it('returns null for an unusable date', () => {
    expect(materialsDeadline({ datum: '' })).toBeNull();
    expect(materialsDeadline({ datum: null })).toBeNull();
    expect(materialsDeadline({ datum: '24-03-2026' })).toBeNull();
    expect(formatDeadline(null)).toBe('');
  });

  /**
   * `2026-02-30` matches the shape and JavaScript rolls it silently forward to 2 March
   * rather than producing NaN, so a naive check yields a tidy deadline of 25 February for
   * a day that does not exist.
   */
  it('rejects calendar dates that do not exist', () => {
    expect(materialsDeadline({ datum: '2026-02-30' })).toBeNull();
    expect(materialsDeadline({ datum: '2026-13-01' })).toBeNull();
    expect(materialsDeadline({ datum: '2026-04-31' })).toBeNull();
    // 2028 is a leap year, 2026 is not.
    expect(materialsDeadline({ datum: '2026-02-29' })).toBeNull();
    expect(materialsDeadline({ datum: '2028-02-29' })?.date).toBe('2028-02-24');
  });

  it('does not shift the day across a daylight-saving boundary', () => {
    // Dutch summer time starts 29 March 2026; UTC day-stepping is unaffected by it.
    expect(materialsDeadline({ datum: '2026-03-31' })).toEqual({
      date: '2026-03-26',
      time: '09:00',
    });
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
