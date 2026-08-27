import { describe, expect, it } from 'vitest';

import { NO_CAPABILITIES, type Capabilities } from '../capabilities';
import { toFullRow, toPublicRows, toRestrictedRow } from '../view-dto';
import { storedRow } from './stored-row.fixture';

const FULL: Capabilities = { view: true, plan: true, full: true };
const RESTRICTED: Capabilities = { view: true, plan: true, full: false };

describe('the public row shapes', () => {
  /**
   * The forcing function for every future field.
   *
   * The mappers list fields explicitly, so adding one to `StoredRow` cannot leak it —
   * but it also cannot reach a planner who needs it, silently. This test fails on any
   * new field and makes the author decide: does it belong in `FullRow`, in
   * `RestrictedRow`, in neither (ranking-only, like `overallAvgScore`)?
   */
  it('pins the persisted field set, so a new one must be decided about', () => {
    expect(Object.keys(storedRow()).sort()).toEqual(
      [
        // NOTE: workload ("Opdrachten deze maand / dit jaar") is deliberately NOT here.
        // It is volatile — booking a trainer elsewhere changes it without advancing this
        // generation — so it is resolved at read time and enriched onto FullRow instead.
        'billableHours',
        'clientTravelChargeCents',
        'hourlyRateCents',
        'overallAvgScore',
        'overallAverageDisplay',
        'overallEvaluationCount',
        'rank',
        'roundTripDurationMinutes',
        'themeAvgScore',
        'themes',
        'totalCostCents',
        'trainerItemId',
        'trainerTravelCostCents',
        'trainingFeeCents',
        'travelTimeCompensationCents',
      ].sort()
    );
  });

  describe('toFullRow', () => {
    /**
     * `trainerOverallAvg` returns 0, not null, for a trainer with no evaluations. On
     * screen that reads as the worst trainer in the list rather than an unknown one, so
     * the ranking scalar must not reach the client even for a `full` caller.
     */
    it('drops the ranking-only scalar', () => {
      const row = toFullRow(storedRow({ overallAvgScore: 0 }), false);

      expect('overallAvgScore' in row).toBe(false);
      // …while the display pair, which CAN express "no grades", survives.
      expect(row.overallAverageDisplay).toBeNull();
      expect(row.overallEvaluationCount).toBeNull();
    });

    it('carries the money a full caller is entitled to', () => {
      const row = toFullRow(storedRow(), true);

      expect(row.hourlyRateCents).toBe(8_400);
      expect(row.totalCostCents).toBe(35_100);
      expect(row.approached).toBe(true);
    });
  });

  describe('toRestrictedRow', () => {
    /**
     * No money at all — not even a total. Travel is zero for an online training, so the
     * total IS the fee, and `Exacte duur` is on the board: dividing recovers the hourly
     * rate exactly.
     */
    it('carries no monetary field of any kind', () => {
      const row = toRestrictedRow(storedRow(), false);

      /**
       * Een exacte sleutellijst, want de bescherming zit hem in wat er NIET in staat.
       *
       * `dayConflicts` staat hier bewust, maar LEEGGEMAAKT: `resolveWorkload` haalt de
       * klantnaam en het tijdstip eruit voor iedereen zonder `full`, omdat `plan`
       * account-breed is en geen toegang tot het agendabord bewijst. Wat overblijft is
       * het feit dat er die dag iets staat. Wie deze lijst uitbreidt hoort dezelfde
       * afweging te maken — er staat een reden bij of het veld hoort er niet.
       */
      expect(Object.keys(row).sort()).toEqual(
        ['approached', 'dayConflicts', 'rank', 'roundTripDurationMinutes', 'trainerItemId'].sort()
      );
      const monetary = Object.keys(row).filter((key) => /cents|fee|cost|rate/i.test(key));
      expect(monetary).toEqual([]);
    });

    /** En het draagt nog steeds niets van de dag als er niets te melden is. */
    it('laat dayConflicts leeg als er die dag niets anders staat', () => {
      expect(toRestrictedRow(storedRow(), false).dayConflicts).toEqual([]);
    });

    it('carries no scores either', () => {
      const row = toRestrictedRow(storedRow({ overallAverageDisplay: 8.4 }), false);
      expect(Object.keys(row)).not.toContain('overallAverageDisplay');
      expect(Object.keys(row)).not.toContain('themes');
    });

    /** A restricted user with `plan` may tick `Benaderd`, so they must see its state. */
    it('still carries approached', () => {
      expect(toRestrictedRow(storedRow(), true).approached).toBe(true);
    });
  });

  describe('toPublicRows', () => {
    it('picks the shape from the caller’s capabilities', () => {
      const rows = [storedRow({ trainerItemId: 't1' })];

      expect(toPublicRows(rows, new Set(), FULL)[0]).toHaveProperty('hourlyRateCents');
      expect(toPublicRows(rows, new Set(), RESTRICTED)[0]).not.toHaveProperty('hourlyRateCents');
      // `view` alone is still restricted — `full` is what unlocks the money.
      expect(
        toPublicRows(rows, new Set(), { ...NO_CAPABILITIES, view: true })[0]
      ).not.toHaveProperty('hourlyRateCents');
    });

    it('marks only the trainers that were approached', () => {
      const rows = [
        storedRow({ trainerItemId: 't1', rank: 1 }),
        storedRow({ trainerItemId: 't2', rank: 2 }),
      ];

      const mapped = toPublicRows(rows, new Set(['t2']), FULL);

      expect(mapped.map((r) => r.approached)).toEqual([false, true]);
    });

    it('preserves the stored order', () => {
      const rows = [
        storedRow({ trainerItemId: 'a', rank: 1 }),
        storedRow({ trainerItemId: 'b', rank: 2 }),
        storedRow({ trainerItemId: 'c', rank: 3 }),
      ];

      expect(toPublicRows(rows, new Set(), RESTRICTED).map((r) => r.trainerItemId)).toEqual([
        'a',
        'b',
        'c',
      ]);
    });
  });
});
