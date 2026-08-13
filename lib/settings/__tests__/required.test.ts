import { describe, expect, it } from 'vitest';

import { buildAppConfig } from '@lib/config';

import { assertRequiredKeys, REQUIRED_APP_KEYS } from '../required';

import type { ConfigRowLike } from '@lib/config';

const complete: ConfigRowLike[] = [
  { key: 'HQ_ADRES', value: 'Wolvenplein 25, Utrecht' },
  { key: 'TRAVEL_RATE_TRAINER_CENTS_PER_KM', value: '23' },
  { key: 'TRAVEL_RATE_CLIENT_CENTS_PER_KM', value: '45' },
  { key: 'TRAVEL_TIME_THRESHOLD_MINUTES', value: '90' },
  { key: 'TRAVEL_TIME_FEE_PER_MINUTE_CENTS', value: '100' },
];

const without = (key: string): ConfigRowLike[] => complete.filter((r) => r.key !== key);

describe('assertRequiredKeys', () => {
  it('passes when every board-owned key is present', () => {
    expect(() => assertRequiredKeys(complete, { requireTrainerGroups: false })).not.toThrow();
  });

  /**
   * The whole reason this module exists.
   *
   * `buildAppConfig` DEFAULTS an absent non-financial key — correct while env was the
   * source, wrong once the board is authoritative. Deleting the `HQ ADRES` row would
   * otherwise restore `Wolvenplein 25, Utrecht` from `CONFIG_DEFAULTS` and price every
   * training from an address nobody chose, with nothing to see anywhere.
   *
   * This test pins the difference: the same rows that `buildAppConfig` happily accepts
   * must be refused here.
   */
  it('rejects a DELETED non-financial row that buildAppConfig would silently default', () => {
    const rows = without('HQ_ADRES');

    // buildAppConfig, on its own, is perfectly happy — and quietly wrong.
    expect(() => buildAppConfig(rows, { isProduction: false })).not.toThrow();
    expect(buildAppConfig(rows, { isProduction: false }).hqAddress).toBe('Wolvenplein 25, Utrecht');

    // The board reader is not.
    expect(() => assertRequiredKeys(rows, { requireTrainerGroups: false })).toThrow(/HQ ADRES/);
  });

  it('rejects every other board-owned key too, not only the financial ones', () => {
    for (const key of REQUIRED_APP_KEYS) {
      expect(() => assertRequiredKeys(without(key), { requireTrainerGroups: false })).toThrow();
    }
  });

  it('names every missing key at once, so one look at the board fixes them all', () => {
    const rows = complete.filter(
      (r) => r.key !== 'HQ_ADRES' && r.key !== 'TRAVEL_TIME_THRESHOLD_MINUTES'
    );
    const run = (): void => assertRequiredKeys(rows, { requireTrainerGroups: false });

    expect(run).toThrow(/HQ ADRES/);
    expect(run).toThrow(/REISTIJD DREMPEL/);
  });

  /**
   * Phase 2a adds `TRAINERGROEPEN` to the required set — but only in the deploy AFTER
   * the row exists, or every board becomes a missing-key outage. The flag is that
   * ordering made explicit rather than left to a code comment.
   */
  describe('TRAINERGROEPEN, once phase 2a has landed', () => {
    it('is not required before the migration', () => {
      expect(() => assertRequiredKeys(complete, { requireTrainerGroups: false })).not.toThrow();
    });

    it('is required after it', () => {
      expect(() => assertRequiredKeys(complete, { requireTrainerGroups: true })).toThrow(
        /TRAINERGROEPEN/
      );

      const withGroups = [
        ...complete,
        { key: 'RECOMMENDABLE_TRAINER_GROUPS', value: 'topics' },
      ];
      expect(() => assertRequiredKeys(withGroups, { requireTrainerGroups: true })).not.toThrow();
    });
  });

  it('reports the BOARD name, not the internal key — that is what ITG can act on', () => {
    expect(() => assertRequiredKeys(without('TRAVEL_TIME_FEE_PER_MINUTE_CENTS'), {
      requireTrainerGroups: false,
    })).toThrow(/REISTIJD VERGOEDING/);
  });
});
