import { z } from 'zod';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@lib/types/database';

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

const readinessSchema = z.object({
  sync_run_id: z.string().nullable(),
  sync_run_started_at: z.string().nullable(),
  groups: z.array(
    z.object({
      monday_group: z.string(),
      trainers: z.number(),
      green_trainers: z.number(),
      green_with_resolvable_rate: z.number(),
      green_without_rate: z.number(),
    })
  ),
});

export interface TrainerGroupCountsSnapshot {
  counts: TrainerGroupCounts[];
  syncRunId: string | null;
  syncStartedAt: string | null;
}

/** Read the per-group counts from the snapshot (plus the sync that produced them). */
export async function readTrainerGroupCounts(
  admin: SupabaseClient<Database>,
  refDate: string
): Promise<TrainerGroupCountsSnapshot> {
  const { data, error } = await admin.rpc('trainer_group_readiness', { p_ref_date: refDate });
  if (error) {
    throw new Error(`trainer_group_readiness: ${error.message}`);
  }
  const parsed = readinessSchema.parse(data);
  return {
    syncRunId: parsed.sync_run_id,
    syncStartedAt: parsed.sync_run_started_at,
    counts: parsed.groups.map((g) => ({
      mondayGroup: g.monday_group,
      trainers: g.trainers,
      greenTrainers: g.green_trainers,
      greenWithResolvableRate: g.green_with_resolvable_rate,
      greenWithoutRate: g.green_without_rate,
    })),
  };
}

/** Why the snapshot can't be reported on. Typed so callers classify without string-matching. */
export type SnapshotIssue =
  | { kind: 'no_sync'; message: string }
  | { kind: 'stale'; message: string }
  | { kind: 'invalid_timestamp'; message: string };

/** Thrown by {@link buildTrainerGroupReport} for an unusable snapshot (vs any other failure). */
export class SnapshotUnavailableError extends Error {
  readonly issue: SnapshotIssue;

  constructor(issue: SnapshotIssue) {
    super(issue.message);
    this.name = 'SnapshotUnavailableError';
    this.issue = issue;
  }
}

const MS_PER_HOUR = 3_600_000;

/**
 * Guard the snapshot: the counts come from M2a while the titles come live from
 * Monday, so reporting on an absent or stale snapshot would pair a fresh board with
 * stale numbers. Returns the issue, or null when the snapshot is usable.
 */
export function snapshotProblem(
  snapshot: Pick<TrainerGroupCountsSnapshot, 'syncRunId' | 'syncStartedAt'>,
  maxAgeMs: number,
  nowMs: number = Date.now()
): SnapshotIssue | null {
  if (!snapshot.syncRunId || !snapshot.syncStartedAt) {
    return {
      kind: 'no_sync',
      message: 'no successful Monday sync yet — run `pnpm sync:monday --apply` first',
    };
  }
  const startedMs = Date.parse(snapshot.syncStartedAt);
  if (Number.isNaN(startedMs)) {
    // Malformed, not old — telling the operator to re-sync would not fix it.
    return {
      kind: 'invalid_timestamp',
      message:
        `sync ${snapshot.syncRunId} has an unparseable started_at ` +
        `(${JSON.stringify(snapshot.syncStartedAt)}) — this is a data defect, not staleness`,
    };
  }
  const ageMs = nowMs - startedMs;
  if (ageMs > maxAgeMs) {
    const hours = Math.round(ageMs / MS_PER_HOUR);
    return {
      kind: 'stale',
      message: `Monday snapshot is stale (${hours}h old) — re-run \`pnpm sync:monday --apply\``,
    };
  }
  return null;
}

/** Reads the live board groups (titles); satisfied by the Monday GraphQL client. */
export interface BoardGroupReader {
  getSchema(boardIds: string[]): Promise<Array<{ id: string; groups: MondayGroupRef[] }>>;
}

export interface TrainerGroupReport {
  rows: TrainerGroupReadiness[];
  selected: string[];
  syncRunId: string | null;
  syncStartedAt: string | null;
  refDate: string;
}

/**
 * Assemble the full report: live Monday titles + snapshot counts + the current
 * selection. Shared by the CLI and the API route so they cannot drift apart.
 * Throws when the snapshot is unusable (see {@link snapshotProblem}).
 */
export async function buildTrainerGroupReport(input: {
  admin: SupabaseClient<Database>;
  reader: BoardGroupReader;
  trainersBoardId: string;
  selected: readonly string[];
  maxAgeMs: number;
  refDate?: string;
  nowMs?: number;
}): Promise<TrainerGroupReport> {
  const refDate = input.refDate ?? new Date(input.nowMs ?? Date.now()).toISOString().slice(0, 10);
  const snapshot = await readTrainerGroupCounts(input.admin, refDate);

  const problem = snapshotProblem(snapshot, input.maxAgeMs, input.nowMs);
  if (problem) {
    throw new SnapshotUnavailableError(problem);
  }

  const boards = await input.reader.getSchema([input.trainersBoardId]);
  const board = boards.find((b) => String(b.id) === input.trainersBoardId);
  if (!board) {
    throw new Error(`trainer board ${input.trainersBoardId} not returned by Monday`);
  }

  return {
    rows: deriveTrainerGroupReadiness({
      mondayGroups: board.groups,
      counts: snapshot.counts,
      selected: input.selected,
    }),
    selected: [...input.selected],
    syncRunId: snapshot.syncRunId,
    syncStartedAt: snapshot.syncStartedAt,
    refDate,
  };
}
