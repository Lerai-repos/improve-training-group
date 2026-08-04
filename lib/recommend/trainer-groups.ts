import { tryResolveHourlyRateCents, type RateCard } from '@lib/calc';

import type { CandidateTrainer, EffectiveQual } from './types';

/**
 * Trainer-group readiness: for each group on the Monday trainer board, whether
 * selecting it in `RECOMMENDABLE_TRAINER_GROUPS` would actually contribute any
 * recommendations. This DETECTS an unconfigured or invalid selection — it cannot
 * prevent one (a direct config edit still applies unchecked), which is why the CLI
 * exits non-zero and the runbook makes running it part of the change procedure.
 */

export type TrainerGroupStatus = 'ready' | 'partial' | 'not_configured' | 'missing_from_monday';

export interface TrainerGroupCounts {
  mondayGroup: string;
  trainers: number;
  greenTrainers: number;
  greenWithResolvableRate: number;
  greenWithoutRate: number;
}

export interface TrainerGroupReadiness extends TrainerGroupCounts {
  id: string;
  /** null when the id is not a group on the live board (typo / renamed / deleted). */
  title: string | null;
  selected: boolean;
  status: TrainerGroupStatus;
}

export interface MondayGroupRef {
  id: string;
  title: string;
}

const EMPTY_COUNTS = {
  trainers: 0,
  greenTrainers: 0,
  greenWithResolvableRate: 0,
  greenWithoutRate: 0,
} as const;

/**
 * Derive readiness from the three inputs. Rows are the UNION of live board groups,
 * configured ids, and ids present in the snapshot — so a selected id that no longer
 * exists on the board surfaces as `missing_from_monday` instead of silently
 * vanishing from a board-only listing.
 */
export function deriveTrainerGroupReadiness(input: {
  mondayGroups: readonly MondayGroupRef[];
  counts: readonly TrainerGroupCounts[];
  selected: readonly string[];
}): TrainerGroupReadiness[] {
  const titleById = new Map(input.mondayGroups.map((g) => [g.id, g.title]));
  const countsById = new Map(input.counts.map((c) => [c.mondayGroup, c]));
  const selected = new Set(input.selected);

  const ids = new Set<string>([
    ...input.mondayGroups.map((g) => g.id),
    ...input.counts.map((c) => c.mondayGroup),
    ...input.selected,
  ]);

  const rows = [...ids].map((id) => {
    const counts = countsById.get(id);
    const onBoard = titleById.has(id);
    return {
      id,
      title: titleById.get(id) ?? null,
      selected: selected.has(id),
      mondayGroup: id,
      trainers: counts?.trainers ?? EMPTY_COUNTS.trainers,
      greenTrainers: counts?.greenTrainers ?? EMPTY_COUNTS.greenTrainers,
      greenWithResolvableRate:
        counts?.greenWithResolvableRate ?? EMPTY_COUNTS.greenWithResolvableRate,
      greenWithoutRate: counts?.greenWithoutRate ?? EMPTY_COUNTS.greenWithoutRate,
      status: statusOf(onBoard, counts),
    };
  });

  // Selected first, then the biggest groups — the rows an operator cares about.
  return rows.sort(
    (a, b) =>
      Number(b.selected) - Number(a.selected) || b.trainers - a.trainers || a.id.localeCompare(b.id)
  );
}

function statusOf(onBoard: boolean, counts: TrainerGroupCounts | undefined): TrainerGroupStatus {
  if (!onBoard) {
    return 'missing_from_monday';
  }
  // No green trainer who can be priced ⇒ selecting this group contributes nothing.
  if (!counts || counts.greenWithResolvableRate === 0) {
    return 'not_configured';
  }
  return counts.greenWithoutRate > 0 ? 'partial' : 'ready';
}

/**
 * The selected groups that would not work — an invalid id, or one that can never
 * contribute a recommendation. `partial` is deliberately NOT included: it still
 * yields usable trainers, so it is a warning rather than a failure.
 */
export function unusableSelections(
  rows: readonly TrainerGroupReadiness[]
): TrainerGroupReadiness[] {
  return rows.filter(
    (r) => r.selected && (r.status === 'missing_from_monday' || r.status === 'not_configured')
  );
}

/**
 * Compute the per-group counts IN PROCESS from the live roster and the live
 * qualifications. This used to be the `trainer_group_readiness` RPC over the
 * Postgres snapshot; reading Monday directly removes the class of bug where a
 * fresh board was paired with stale numbers, so there is no snapshot to guard.
 *
 * Counts are INTERSECTION-based, not independent totals: a group where one trainer
 * has a rate and a DIFFERENT one is green is not ready. What matters is the overlap
 * — green trainers who can actually be priced.
 */
export function computeTrainerGroupCounts(input: {
  roster: readonly CandidateTrainer[];
  effective: readonly EffectiveQual[];
  rateCards: readonly RateCard[];
  refDate: string;
}): TrainerGroupCounts[] {
  const greenTrainerIds = new Set(
    input.effective.filter((e) => e.effective === 'green').map((e) => e.trainerExternalId)
  );
  const byGroup = new Map<string, TrainerGroupCounts>();
  for (const t of input.roster) {
    const group = t.mondayGroup;
    if (group === null) {
      continue;
    }
    const row = byGroup.get(group) ?? { mondayGroup: group, ...EMPTY_COUNTS };
    const next = { ...row, trainers: row.trainers + 1 };
    if (greenTrainerIds.has(t.externalItemId)) {
      // "Has a rate_key" is NOT "has a rate": cards are date-scoped and can be
      // trainer-scoped, so resolvability is checked properly.
      const priceable =
        t.rateKey !== null &&
        tryResolveHourlyRateCents(input.rateCards, t.rateKey, t.externalItemId, input.refDate) !==
          null;
      byGroup.set(group, {
        ...next,
        greenTrainers: next.greenTrainers + 1,
        greenWithResolvableRate: next.greenWithResolvableRate + (priceable ? 1 : 0),
        greenWithoutRate: next.greenWithoutRate + (priceable ? 0 : 1),
      });
    } else {
      byGroup.set(group, next);
    }
  }
  return [...byGroup.values()];
}

/** Reads the live board groups (titles); satisfied by the Monday GraphQL client. */
export interface BoardGroupReader {
  getSchema(boardIds: string[]): Promise<Array<{ id: string; groups: MondayGroupRef[] }>>;
}

export interface TrainerGroupReport {
  rows: TrainerGroupReadiness[];
  selected: string[];
  refDate: string;
}

/**
 * Assemble the full report: live Monday titles + counts computed from the live
 * roster and qualifications + the current selection. Shared by the CLI and the API
 * route so they cannot drift apart.
 *
 * Everything here is read live, so there is no snapshot to be stale and no
 * `SnapshotUnavailableError` any more — the failure mode it guarded is gone rather
 * than handled.
 */
export async function buildTrainerGroupReport(input: {
  reader: BoardGroupReader;
  trainersBoardId: string;
  roster: readonly CandidateTrainer[];
  effective: readonly EffectiveQual[];
  rateCards: readonly RateCard[];
  selected: readonly string[];
  refDate?: string;
  nowMs?: number;
}): Promise<TrainerGroupReport> {
  const refDate = input.refDate ?? new Date(input.nowMs ?? Date.now()).toISOString().slice(0, 10);
  const counts = computeTrainerGroupCounts({
    roster: input.roster,
    effective: input.effective,
    rateCards: input.rateCards,
    refDate,
  });

  const boards = await input.reader.getSchema([input.trainersBoardId]);
  const board = boards.find((b) => String(b.id) === input.trainersBoardId);
  if (!board) {
    throw new Error(`trainer board ${input.trainersBoardId} not returned by Monday`);
  }

  return {
    rows: deriveTrainerGroupReadiness({
      mondayGroups: board.groups,
      counts,
      selected: input.selected,
    }),
    selected: [...input.selected],
    refDate,
  };
}
