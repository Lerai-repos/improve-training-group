import type { AssignmentCounts, DayConflict } from './assignments';
import type { Capabilities } from './capabilities';
import type { StoredRow, StoredRowTheme } from './view-row';

/**
 * What leaves the server. Three shapes, mapped explicitly, never passed through.
 *
 * {@link StoredRow} carries `overallAvgScore`, the legacy scalar that is **0 for a
 * trainer with no evaluations at all** (`weighted-avg.ts`). It is fine for sorting and
 * catastrophic on screen — a newly qualified trainer would read as the worst in the
 * list, which is exactly the "geen cijfers" vs "slechte cijfers" confusion the spec
 * calls the planner's most-asked question. Serializing the persisted row would leak it,
 * so the public shapes are built field by field.
 *
 * **Explicit lists, not `Omit`.** `Omit<StoredRow, 'overallAvgScore'>` would be shorter
 * and would automatically re-expose the next ranking-only field somebody adds. Exposure
 * should be a decision; the key-set test in `view-dto.test.ts` is what makes the
 * decision unavoidable rather than merely available.
 */

/** Everything a `full` caller may see. */
export interface FullRow {
  /**
   * Andere trainingen die deze trainer op dezelfde dag al heeft. Leeg is de normale stand.
   *
   * Een vlag, geen oordeel: twee sessies op één dag is bij ITG legitiem (ochtend plus
   * middag), dus wegfilteren zou geldige opties weghalen zonder dat de planner ziet waarom.
   */
  dayConflicts?: readonly DayConflict[];
  trainerItemId: string;
  rank: number;
  themes: StoredRowTheme[];
  themeAvgScore: number | null;
  /** Null when there is nothing to average — NOT 0. */
  overallAverageDisplay: number | null;
  overallEvaluationCount: number | null;
  hourlyRateCents: number;
  billableHours: number;
  trainingFeeCents: number;
  trainerTravelCostCents: number;
  roundTripDurationMinutes: number;
  travelTimeCompensationCents: number;
  clientTravelChargeCents: number;
  totalCostCents: number;
  /**
   * How much this trainer already has on in the training's month / year.
   *
   * Resolved at READ time, not stored: linking a trainer elsewhere changes their load
   * without touching this training's generation, so a persisted count would be served
   * for months with nothing to mark it stale. **Null means "we could not find out"** —
   * never 0, which is a real and very different answer.
   */
  assignmentsThisMonth: number | null;
  assignmentsThisYear: number | null;
  approached: boolean;
}

/**
 * What everyone else sees: no money at all.
 *
 * Not even a total, and not a band. An exact total is unsafe because travel is zero for
 * an online training, so `totalCostCents === trainingFeeCents` (`cost.ts`), and
 * `Exacte duur` is on the board — dividing recovers the hourly rate exactly. Bands were
 * the alternative and are rejected on both horns: fine enough to be useful narrows the
 * rate, coarse enough to be safe tells the planner nothing.
 *
 * `rank` stays, and leaks exactly one thing — relative order, nothing about magnitude.
 * That is inherent to showing an ordered list at all, and is called out in the audience
 * decision rather than left to be discovered.
 */
export interface RestrictedRow {
  trainerItemId: string;
  rank: number;
  roundTripDurationMinutes: number;
  approached: boolean;
  /**
   * Ook hier, want de Kies-knop hangt aan `plan` en niet aan `full`.
   *
   * Die knop koppelt een trainer aan een training. De waarschuwing erachter laten hangen
   * aan een ándere capability betekent dat precies de gebruiker die de handeling doet hem
   * niet ziet.
   *
   * **In deze vorm staat alleen het FEIT.** `resolveWorkload` haalt klantnaam en tijdstip
   * eruit voor iedereen zonder `full`. Eerder stond hier dat die twee "al op het bord
   * staan dat deze gebruiker mag lezen" — dat was onjuist: capabilities zijn account-breed
   * en niet bord-gebonden, dus `plan` bewijst geen toegang tot het agendabord. Zie
   * `capabilities.ts`, dat óók vastlegt waarom `full` die details wél krijgt.
   */
  dayConflicts?: readonly DayConflict[];
}

export type PublicRow = FullRow | RestrictedRow;

export function toFullRow(
  row: StoredRow,
  approached: boolean,
  workload: AssignmentCounts | null = null,
  dayConflicts: readonly DayConflict[] = []
): FullRow {
  return {
    trainerItemId: row.trainerItemId,
    rank: row.rank,
    themes: row.themes,
    themeAvgScore: row.themeAvgScore,
    overallAverageDisplay: row.overallAverageDisplay,
    overallEvaluationCount: row.overallEvaluationCount,
    hourlyRateCents: row.hourlyRateCents,
    billableHours: row.billableHours,
    trainingFeeCents: row.trainingFeeCents,
    trainerTravelCostCents: row.trainerTravelCostCents,
    roundTripDurationMinutes: row.roundTripDurationMinutes,
    travelTimeCompensationCents: row.travelTimeCompensationCents,
    clientTravelChargeCents: row.clientTravelChargeCents,
    totalCostCents: row.totalCostCents,
    assignmentsThisMonth: workload?.thisMonth ?? null,
    assignmentsThisYear: workload?.thisYear ?? null,
    dayConflicts,
    approached,
  };
}

export function toRestrictedRow(
  row: StoredRow,
  approached: boolean,
  dayConflicts: readonly DayConflict[] = []
): RestrictedRow {
  return {
    trainerItemId: row.trainerItemId,
    rank: row.rank,
    roundTripDurationMinutes: row.roundTripDurationMinutes,
    dayConflicts,
    approached,
  };
}

/**
 * Map a stored list for one caller.
 *
 * `approached` is present in BOTH shapes: a restricted user with `plan` may tick
 * `Benaderd`, so they must be able to see its current state.
 */
/** Looks up a trainer's current workload; null when it could not be determined. */
export type WorkloadLookup = (trainerItemId: string) => AssignmentCounts | null;

/**
 * What else this trainer has on the training's own day. Empty when unknown.
 *
 * Empty and "nothing else that day" deliberately look the same. The label is additive —
 * absence of a warning has never meant "verified free", and a scan that could not resolve
 * the day must not start claiming it did.
 */
export type DayConflictLookup = (trainerItemId: string) => readonly DayConflict[];

export function toPublicRows(
  rows: readonly StoredRow[],
  approached: ReadonlySet<string>,
  caps: Capabilities,
  workload: WorkloadLookup = () => null,
  dayConflicts: DayConflictLookup = () => []
): PublicRow[] {
  return rows.map((row) =>
    caps.full
      ? toFullRow(
          row,
          approached.has(row.trainerItemId),
          workload(row.trainerItemId),
          dayConflicts(row.trainerItemId)
        )
      : toRestrictedRow(row, approached.has(row.trainerItemId), dayConflicts(row.trainerItemId))
  );
}
