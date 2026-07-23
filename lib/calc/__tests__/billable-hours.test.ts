import { describe, expect, it } from 'vitest';

import { billableHours } from '../billable-hours';

describe('billableHours', () => {
  it('floors short sessions up (Kevin-confirmed cases)', () => {
    expect(billableHours(2)).toBe(3);
    expect(billableHours(3)).toBe(3.5);
  });

  it('bills the actual duration at 4h and above', () => {
    expect(billableHours(4)).toBe(4);
    expect(billableHours(5)).toBe(5);
    expect(billableHours(8)).toBe(8);
  });

  it('handles fractional short durations', () => {
    expect(billableHours(1)).toBe(2.5);
    expect(billableHours(3.5)).toBe(3.75);
  });

  it('passes zero and negative durations through unchanged', () => {
    expect(billableHours(0)).toBe(0);
    expect(billableHours(-1)).toBe(-1);
  });
});
