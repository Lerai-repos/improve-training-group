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
  { key: 'RECOMMENDABLE_TRAINER_GROUPS', value: 'topics' },
];

const without = (key: string): ConfigRowLike[] => complete.filter((r) => r.key !== key);

describe('assertRequiredKeys', () => {
  it('passes when every board-owned key is present', () => {
    expect(() => assertRequiredKeys(complete)).not.toThrow();
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
    expect(() => assertRequiredKeys(rows)).toThrow(/HQ ADRES/);
  });

  it('rejects every other board-owned key too, not only the financial ones', () => {
    for (const key of REQUIRED_APP_KEYS) {
      expect(() => assertRequiredKeys(without(key))).toThrow();
    }
  });

  it('names every missing key at once, so one look at the board fixes them all', () => {
    const rows = complete.filter(
      (r) => r.key !== 'HQ_ADRES' && r.key !== 'TRAVEL_TIME_THRESHOLD_MINUTES'
    );
    const run = (): void => assertRequiredKeys(rows);

    expect(run).toThrow(/HQ ADRES/);
    expect(run).toThrow(/REISTIJD DREMPEL/);
  });

  /**
   * The fase-2a cutover has landed: the group selection is a required BOARD key, with no
   * flag and no environment fallback left. The flag existed only to sequence the rollout;
   * deleting it is what guarantees no caller can ask for the lenient reading any more.
   */
  describe('TRAINERGROEPEN', () => {
    it('is required like every other board key', () => {
      expect(() => assertRequiredKeys(without('RECOMMENDABLE_TRAINER_GROUPS'))).toThrow(
        /TRAINERGROEPEN/
      );
    });

    /**
     * "Row absent" and "row present, nothing selected" need DIFFERENT instructions.
     * Telling someone who is looking straight at the row that it is missing sends them
     * to create a second one — and a duplicate key is refused, so the board would then
     * be broken in a new way by following our own error message.
     */
    it('distinguishes an empty selection from a missing row', () => {
      const absent = (): void => assertRequiredKeys(without('RECOMMENDABLE_TRAINER_GROUPS'));
      const empty = (): void => assertRequiredKeys(complete, { emptySelection: true });

      expect(absent).toThrow(/mist de rij/);
      expect(empty).toThrow(/geen groep geselecteerd/);
      expect(empty).not.toThrow(/mist de rij/);
    });

    /**
     * An empty selection is fatal even when the row itself is present, which is the case
     * the env fallback used to swallow: before this deploy it read as "absent", the
     * environment answered, and the board edit had no visible effect at all.
     */
    it('refuses an empty selection on an otherwise complete board', () => {
      expect(() => assertRequiredKeys(complete, { emptySelection: true })).toThrow();
    });
  });

  it('reports the BOARD name, not the internal key — that is what ITG can act on', () => {
    expect(() => assertRequiredKeys(without('TRAVEL_TIME_FEE_PER_MINUTE_CENTS'))).toThrow(
      /REISTIJD VERGOEDING/
    );
  });
});
