/**
 * What `pnpm trainers:tarief` would write, decided without touching Monday.
 *
 * Pure so the interesting half is testable: which trainers get a rate, where the amount
 * comes from, and everything the command must refuse to do.
 */

import { tryResolveHourlyRateCents } from '@lib/calc';
import { GROUP_POLICY } from '@lib/monday/board-config';

import { centsToEuros } from './uurtarief';

import type { RateCard } from '@lib/calc';

/** One trainer as the migration sees them. */
export interface TrainerRow {
  readonly itemId: string;
  readonly naam: string;
  readonly groupId: string | null;
  readonly groupTitle: string;
  /** The current `Uurtarief` cell, rendered. Non-empty means hands off. */
  readonly uurtarief: string | null;
}

export interface PlannedWrite {
  readonly itemId: string;
  readonly naam: string;
  readonly groupTitle: string;
  readonly rateKey: string;
  /** Exactly what goes into the cell, in euros. */
  readonly euros: string;
}

export interface TariefPlan {
  readonly writes: readonly PlannedWrite[];
  /** Already filled in: reported, never overwritten. */
  readonly alreadySet: ReadonlyArray<{ naam: string; groupTitle: string; current: string }>;
  /** In a group that maps to no cohort, so there is nothing to derive. */
  readonly noCohort: ReadonlyArray<{ groupTitle: string; count: number }>;
}

/**
 * The euro amount per cohort, taken from the LIVE rate cards.
 *
 * Never a constant. `88` and `84` are what the code shipped with, but Instellingen owns
 * these amounts now and ITG can change them. Hardcoding would let a migration that is
 * supposed to change only *where* the rate comes from quietly change the rate itself —
 * the same trap the fase-2a seed had to avoid.
 *
 * `on` is the date the cards are resolved for. Rates are flat rather than effective-dated
 * in practice, but the resolver is date-aware, so the caller says which day it means
 * instead of this module assuming one.
 */
export function cohortEuros(cards: readonly RateCard[], on: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [groupId, policy] of Object.entries(GROUP_POLICY)) {
    if (policy.rateKey === null) {
      continue;
    }
    /**
     * Resolved with a trainer id no card can match, deliberately.
     *
     * We want the COHORT default, and passing a real trainer would silently pick up a
     * trainer-scoped override and write one person's rate onto everyone in their group.
     */
    const cents = tryResolveHourlyRateCents(cards, policy.rateKey, '', on);
    if (cents === null) {
      throw new Error(
        `Geen tarief gevonden voor cohort "${policy.rateKey}" op ${on} — ` +
          'controleer de TARIEF-rijen op het Instellingen-bord'
      );
    }
    out.set(groupId, centsToEuros(cents));
  }
  if (out.size === 0) {
    throw new Error('GROUP_POLICY bevat geen enkele groep met een cohort — niets af te leiden');
  }
  return out;
}

export function planTarief(
  rows: readonly TrainerRow[],
  euroByGroup: ReadonlyMap<string, string>
): TariefPlan {
  const writes: PlannedWrite[] = [];
  const alreadySet: Array<{ naam: string; groupTitle: string; current: string }> = [];
  const noCohortByGroup = new Map<string, number>();

  for (const row of rows) {
    const euros = row.groupId === null ? undefined : euroByGroup.get(row.groupId);
    if (euros === undefined) {
      noCohortByGroup.set(row.groupTitle, (noCohortByGroup.get(row.groupTitle) ?? 0) + 1);
      continue;
    }

    /**
     * A filled cell is somebody's decision, not a gap.
     *
     * Item values have no revision or CAS, so "it looks like the cohort rate anyway, I'll
     * just rewrite it" is a blind overwrite whose read-back only confirms our own write.
     * Reported and left alone, exactly as the settings migration does.
     */
    if (row.uurtarief !== null && row.uurtarief.trim() !== '') {
      alreadySet.push({ naam: row.naam, groupTitle: row.groupTitle, current: row.uurtarief });
      continue;
    }

    const rateKey = row.groupId === null ? null : (GROUP_POLICY[row.groupId]?.rateKey ?? null);
    if (rateKey === null) {
      // Unreachable while `euroByGroup` is built from the same table, and cheaper to
      // assert than to reason about every future caller.
      throw new Error(`Groep ${row.groupId} heeft een bedrag maar geen rateKey`);
    }

    writes.push({
      itemId: row.itemId,
      naam: row.naam,
      groupTitle: row.groupTitle,
      rateKey,
      euros,
    });
  }

  return {
    writes,
    alreadySet,
    noCohort: [...noCohortByGroup.entries()]
      .map(([groupTitle, count]) => ({ groupTitle, count }))
      .sort((a, b) => b.count - a.count),
  };
}
