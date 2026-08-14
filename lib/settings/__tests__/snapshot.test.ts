import { describe, expect, it } from 'vitest';

import { buildSettingsSnapshot } from '../snapshot';

import type { RawSettings } from '../read';

const raw = (): RawSettings => ({
  appRows: [
    { key: 'HQ_ADRES', value: 'Wolvenplein 25, Utrecht' },
    { key: 'TRAVEL_RATE_TRAINER_CENTS_PER_KM', value: '23' },
    { key: 'TRAVEL_RATE_CLIENT_CENTS_PER_KM', value: '45' },
    { key: 'TRAVEL_TIME_THRESHOLD_MINUTES', value: '90' },
    { key: 'TRAVEL_TIME_FEE_PER_MINUTE_CENTS', value: '100' },
  ],
  rateCents: new Map([
    ['2020-2024', 8800],
    ['2024-heden', 8400],
  ]),
  emptyGroupSelection: false,
});

const opts = {
  boardId: '123',
  isProduction: false,
  requireTrainerGroups: false,
  readAt: 1_760_000_000_000,
};

describe('buildSettingsSnapshot', () => {
  it('assembles config and rate cards from the board', () => {
    const snapshot = buildSettingsSnapshot(raw(), { ...opts, env: {} });

    expect(snapshot.app.hqAddress).toBe('Wolvenplein 25, Utrecht');
    expect(snapshot.app.travelRateTrainerCentsPerKm).toBe(23);
    expect(snapshot.rateCards).toHaveLength(2);
    expect(snapshot.boardId).toBe('123');
    expect(snapshot.readAt).toBe(opts.readAt);
  });

  it('refuses a board with a row deleted', () => {
    const missing = raw();
    missing.appRows = missing.appRows.filter((r) => r.key !== 'HQ_ADRES');

    expect(() => buildSettingsSnapshot(missing, { ...opts, env: {} })).toThrow(/HQ ADRES/);
  });

  /**
   * `TRAVEL_TIME_MODE` and `THRESHOLD_HOURS` are deliberately kept OFF the board — but
   * they are still `AppConfig` fields, so once env stops being the source
   * `buildAppConfig` fills them from `CONFIG_DEFAULTS` and silently discards whatever
   * production had set. `travelTimeMode` is copied into `EngineConfig.travelTimeConfig`
   * and changes pricing behaviour, so this is not cosmetic.
   *
   * "Not ITG-editable" is not the same as "not configured".
   */
  describe('off-board values', () => {
    it('carries a non-default env value through the source switch', () => {
      const snapshot = buildSettingsSnapshot(raw(), {
        ...opts,
        env: { THRESHOLD_HOURS: '6' },
      });

      expect(snapshot.app.evaluationThresholdHours).toBe(6);
    });

    it('keeps travelTimeMode, which reaches the pricing config', () => {
      const snapshot = buildSettingsSnapshot(raw(), {
        ...opts,
        env: { TRAVEL_TIME_MODE: 'per_minute' },
      });

      expect(snapshot.app.travelTimeMode).toBe('per_minute');
    });

    it('falls back to the default when the variable is genuinely absent', () => {
      const snapshot = buildSettingsSnapshot(raw(), { ...opts, env: {} });

      expect(snapshot.app.evaluationThresholdHours).toBe(4);
    });
  });

  /**
   * Phase 1's board has no `TRAINERGROEPEN` row, so without this injection
   * `buildAppConfig` would fill `recommendableTrainerGroups` from `CONFIG_DEFAULTS` —
   * the GROUP_POLICY default, NOT the live override — quietly changing who is eligible
   * on the very deploy that was supposed to change nothing but the source.
   */
  describe('trainer groups during phase 1', () => {
    it('uses the effective env selection, not the code default', () => {
      const snapshot = buildSettingsSnapshot(raw(), {
        ...opts,
        env: { RECOMMENDABLE_TRAINER_GROUPS: 'nieuwe_groep__1' },
      });

      expect(snapshot.app.recommendableTrainerGroups).toEqual(['nieuwe_groep__1']);
    });

    it('prefers the board row once one exists', () => {
      const withRow = raw();
      withRow.appRows.push({ key: 'RECOMMENDABLE_TRAINER_GROUPS', value: 'topics' });

      const snapshot = buildSettingsSnapshot(withRow, {
        ...opts,
        env: { RECOMMENDABLE_TRAINER_GROUPS: 'nieuwe_groep__1' },
      });

      expect(snapshot.app.recommendableTrainerGroups).toEqual(['topics']);
    });
  });

  /**
   * The fingerprint exists so a stored outcome can be lined up against the board's
   * activity log despite the five-minute cache. It must move when the effective values
   * move — and NOT when only their formatting does, or it would report a change that
   * never reached the engine.
   */
  describe('fingerprint', () => {
    it('is stable for the same effective values', () => {
      const a = buildSettingsSnapshot(raw(), { ...opts, env: {} });
      const b = buildSettingsSnapshot(raw(), { ...opts, env: {}, readAt: opts.readAt + 60_000 });

      expect(a.fingerprint).toBe(b.fingerprint);
    });

    it('does not move for a formatting-only edit', () => {
      const dutch = raw();
      // `0,23` and `0.23` both normalise to 23 cents before they reach here.
      dutch.appRows = dutch.appRows.map((r) =>
        r.key === 'TRAVEL_RATE_TRAINER_CENTS_PER_KM' ? { ...r, value: '23' } : r
      );

      expect(buildSettingsSnapshot(dutch, { ...opts, env: {} }).fingerprint).toBe(
        buildSettingsSnapshot(raw(), { ...opts, env: {} }).fingerprint
      );
    });

    it('moves when a value actually changes', () => {
      const dearer = raw();
      dearer.appRows = dearer.appRows.map((r) =>
        r.key === 'TRAVEL_RATE_TRAINER_CENTS_PER_KM' ? { ...r, value: '24' } : r
      );

      expect(buildSettingsSnapshot(dearer, { ...opts, env: {} }).fingerprint).not.toBe(
        buildSettingsSnapshot(raw(), { ...opts, env: {} }).fingerprint
      );
    });

    it('moves when a tariff changes', () => {
      const dearer = raw();
      dearer.rateCents.set('2020-2024', 9000);

      expect(buildSettingsSnapshot(dearer, { ...opts, env: {} }).fingerprint).not.toBe(
        buildSettingsSnapshot(raw(), { ...opts, env: {} }).fingerprint
      );
    });

    it('does not contain the raw address', () => {
      const snapshot = buildSettingsSnapshot(raw(), { ...opts, env: {} });

      expect(snapshot.fingerprint).not.toContain('Wolvenplein');
    });
  });
});

/**
 * The check that proves the phase-2a migration actually landed.
 *
 * `RECOMMENDABLE_TRAINER_GROUPS` is deliberately RETAINED in the environment for
 * rollback, so if required keys were checked against the merged rows the retained
 * variable would satisfy `requireTrainerGroups: true` on a board with no
 * `TRAINERGROEPEN` row — and deploy ④ would report success having verified nothing.
 */
describe('required keys are satisfied by the BOARD, never by env', () => {
  it('still fails when the row is missing but the rollback env var is set', () => {
    expect(() =>
      buildSettingsSnapshot(raw(), {
        ...opts,
        requireTrainerGroups: true,
        env: { RECOMMENDABLE_TRAINER_GROUPS: 'topics' },
      })
    ).toThrow(/TRAINERGROEPEN/);
  });

  it('passes once the row is actually on the board', () => {
    const withRow = raw();
    withRow.appRows.push({ key: 'RECOMMENDABLE_TRAINER_GROUPS', value: 'topics' });

    expect(() =>
      buildSettingsSnapshot(withRow, {
        ...opts,
        requireTrainerGroups: true,
        env: { RECOMMENDABLE_TRAINER_GROUPS: 'nieuwe_groep__1' },
      })
    ).not.toThrow();
  });

  it('an env value cannot stand in for a deleted board row either', () => {
    const missing = raw();
    missing.appRows = missing.appRows.filter((r) => r.key !== 'HQ_ADRES');

    expect(() =>
      buildSettingsSnapshot(missing, { ...opts, env: { HQ_ADRES: 'Ergens 1, Utrecht' } })
    ).toThrow(/HQ ADRES/);
  });

  /** An empty selection reaches the snapshot as its own state, not as an absent row. */
  it('reports an empty selection distinctly once the row is required', () => {
    const empty = { ...raw(), emptyGroupSelection: true };

    expect(() =>
      buildSettingsSnapshot(empty, { ...opts, requireTrainerGroups: true })
    ).toThrow(/geen groep geselecteerd/);
  });
});

/**
 * The migration's ONLY proof is "the fingerprint did not move when the source did", so a
 * hash that reacts to something the engine ignores would raise a false alarm on a correct
 * migration — and a check that cries wolf once gets overridden the next time.
 */
describe('fingerprint canonicalisation', () => {
  const withGroups = (value: string): RawSettings => {
    const rows = raw();
    rows.appRows.push({ key: 'RECOMMENDABLE_TRAINER_GROUPS', value });
    return rows;
  };

  const fingerprint = (value: string): string =>
    buildSettingsSnapshot(withGroups(value), opts).fingerprint;

  it('does not move when the same groups arrive in a different order', () => {
    expect(fingerprint('topics,nieuwe_groep__1')).toBe(fingerprint('nieuwe_groep__1,topics'));
  });

  it('does not move when a group is listed twice', () => {
    expect(fingerprint('topics,topics')).toBe(fingerprint('topics'));
  });

  it('still moves when the membership actually changes', () => {
    expect(fingerprint('topics')).not.toBe(fingerprint('topics,nieuwe_groep__1'));
  });
});
