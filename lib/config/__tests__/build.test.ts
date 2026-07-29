import { describe, expect, it } from 'vitest';

import { buildAppConfig, type ConfigRowLike } from '../build';
import { CONFIG_DEFAULTS } from '../defaults';

const dev = { isProduction: false };
const prod = { isProduction: true };

const allRows: ConfigRowLike[] = [
  { key: 'HQ_ADRES', value: 'Somewhere 1, Utrecht' },
  { key: 'THRESHOLD_HOURS', value: '2' },
  { key: 'TRAVEL_RATE_TRAINER_CENTS_PER_KM', value: '25' },
  { key: 'TRAVEL_RATE_CLIENT_CENTS_PER_KM', value: '50' },
  { key: 'TRAVEL_TIME_THRESHOLD_MINUTES', value: '60' },
  { key: 'TRAVEL_TIME_MODE', value: 'hourly_rate' },
  { key: 'TRAVEL_TIME_FEE_PER_MINUTE_CENTS', value: '120' },
];

describe('buildAppConfig', () => {
  it('reads DB values, coercing numbers', () => {
    const cfg = buildAppConfig(allRows, dev);
    expect(cfg.hqAddress).toBe('Somewhere 1, Utrecht');
    expect(cfg.evaluationThresholdHours).toBe(2);
    expect(cfg.travelRateTrainerCentsPerKm).toBe(25);
    expect(cfg.travelTimeMode).toBe('hourly_rate');
  });

  it('falls back to defaults for missing keys in development', () => {
    const cfg = buildAppConfig([], dev);
    expect(cfg).toEqual(CONFIG_DEFAULTS);
  });

  it('throws in production when a financial key is missing', () => {
    const rows = allRows.filter((r) => r.key !== 'TRAVEL_RATE_TRAINER_CENTS_PER_KM');
    expect(() => buildAppConfig(rows, prod)).toThrow(/TRAVEL_RATE_TRAINER_CENTS_PER_KM/);
  });

  it('does NOT throw in production for a missing non-financial key', () => {
    const rows = allRows.filter((r) => r.key !== 'HQ_ADRES');
    const cfg = buildAppConfig(rows, prod);
    expect(cfg.hqAddress).toBe(CONFIG_DEFAULTS.hqAddress);
  });

  it('uses defaults for financial keys in development (no throw)', () => {
    const rows = allRows.filter(
      (r) => !r.key.startsWith('TRAVEL_RATE') && r.key !== 'TRAVEL_TIME_FEE_PER_MINUTE_CENTS'
    );
    const cfg = buildAppConfig(rows, dev);
    expect(cfg.travelRateTrainerCentsPerKm).toBe(CONFIG_DEFAULTS.travelRateTrainerCentsPerKm);
  });

  it('rejects an invalid enum value', () => {
    const rows = allRows.map((r) =>
      r.key === 'TRAVEL_TIME_MODE' ? { ...r, value: 'nonsense' } : r
    );
    expect(() => buildAppConfig(rows, dev)).toThrow();
  });

  it('rejects a non-numeric numeric value', () => {
    const rows = allRows.map((r) => (r.key === 'THRESHOLD_HOURS' ? { ...r, value: 'abc' } : r));
    expect(() => buildAppConfig(rows, dev)).toThrow();
  });
});

describe('RECOMMENDABLE_TRAINER_GROUPS', () => {
  const withGroups = (value: string): ConfigRowLike[] => [
    ...allRows,
    { key: 'RECOMMENDABLE_TRAINER_GROUPS', value },
  ];

  it('parses a comma-separated list, trimming whitespace', () => {
    const cfg = buildAppConfig(withGroups(' topics , group_x,group_y '), dev);
    expect(cfg.recommendableTrainerGroups).toEqual(['topics', 'group_x', 'group_y']);
  });

  it('accepts a single group', () => {
    expect(buildAppConfig(withGroups('topics'), dev).recommendableTrainerGroups).toEqual([
      'topics',
    ]);
  });

  it('an ABSENT row falls back to the default', () => {
    const cfg = buildAppConfig(allRows, dev);
    expect(cfg.recommendableTrainerGroups).toEqual(CONFIG_DEFAULTS.recommendableTrainerGroups);
  });

  it('a PRESENT but empty row THROWS (never silently re-enables the defaults)', () => {
    expect(() => buildAppConfig(withGroups(''), dev)).toThrow();
    expect(() => buildAppConfig(withGroups('   ,  , '), dev)).toThrow();
  });

  it('passes unknown group ids through — the readiness listing surfaces them, not the parser', () => {
    const cfg = buildAppConfig(withGroups('topics,typo_group'), dev);
    expect(cfg.recommendableTrainerGroups).toEqual(['topics', 'typo_group']);
  });
});
