import type { Qualification } from '@lib/calc';

/**
 * The domain types shared by the evaluation modules.
 *
 * `lib/evaluations` may import `@lib/calc` and `@lib/monday`, never `@lib/recommend`:
 * the engine adapter (`lib/recommend/eval-stats.ts`) imports this module, so the
 * reverse edge would close a cycle. Anything the roll-up needs from the recommend side
 * — qualifications especially — arrives as plain data, defined here.
 */

/** Which document and tab a response came from. Provenance only; never a join key. */
export interface SheetRef {
  /** Google spreadsheet id, or a fixture id such as `csv:nl`. */
  readonly documentId: string;
  readonly sheetName: string;
  /** Free label for the run log and the per-document baseline: 'nl' | 'en' | 'oud-2024'. */
  readonly label: string;
}

/**
 * One submitted form response, decoded to only what the recommendations consume.
 *
 * `receivedAtRaw` is a string and is **never parsed**. Fourteen real NL rows carry a
 * sequence number `1`…`14` in Tijdstempel — paper evaluations typed in by hand — so a
 * `z.string().datetime()` here, or a "skip rows without a valid timestamp" rule, would
 * delete them behind a green run. Nothing downstream needs the moment a response
 * arrived; attribution is by IE-code alone.
 */
export interface EvaluationResponse {
  readonly source: SheetRef;
  /** 1-based row number IN THE SHEET (the header is row 1), so a report can point at it. */
  readonly rowNumber: number;
  /** The IE-code cell, untouched. Normalisation belongs to `attribute.ts`. */
  readonly rawCode: string;
  /** The eindcijfer, or null when the cell was blank or unparseable. */
  readonly grade: number | null;
  readonly receivedAtRaw: string | null;
}

/**
 * One training's evaluation aggregate — the bridge from `attribute.ts` to `stats.ts`.
 *
 * Structurally a superset of `@lib/calc`'s `TrainingEval`, deliberately: the projection
 * into the calc layer is a field pick, not a conversion.
 */
export interface TrainingAggregate {
  readonly trainingItemId: string;
  /** `round2` of the mean of PARSEABLE grades; null when none parsed. */
  readonly avgOverallGrade: number | null;
  /** Legacy `matches.length` — every matched row, blank grade included. */
  readonly evaluationCount: number;
  /** Which code(s) produced these responses. For the dry-run report. */
  readonly matchedCodes: readonly string[];
}

/** A training as far as the IE-code join cares. */
export interface TrainingRef {
  readonly trainingItemId: string;
  /** Raw `tekst_mkn58pt6`; may hold several codes: `"E60GE, E60LE"`. */
  readonly rawIeCode: string | null;
  /**
   * The klant, from the `board_relation` link — NOT the mirror and NOT the item name.
   *
   * Together with {@link themaKey} this decides whether several trainings sharing one
   * code are **one session** (ITG gives a repeated or co-delivered course a single code
   * on purpose) or an accidental collision between unrelated clients. Null when the link
   * is empty, which forces the collision branch: unknown is never "the same".
   */
  readonly clientKey: string | null;
  /**
   * The training's thema ids, sorted and joined — the second half of the same test.
   *
   * Required even though every same-klant code in the corpus already matches on it:
   * one client running two DIFFERENT courses under one code is genuinely ambiguous, and
   * klant alone would wave that through.
   */
  readonly themaKey: string | null;
}

/** One training as the roll-up sees it, already column-mapped per jaargang. */
export interface TrainingHistoryEntry {
  readonly trainingItemId: string;
  /** `datum_1` as `YYYY-MM-DD`, or null. */
  readonly datum: string | null;
  readonly trainerExternalIds: readonly string[];
  readonly themaExternalIds: readonly string[];
}

/**
 * One (trainer, thema) pair's raw qualification colours, as observed on the Thema's
 * board.
 *
 * RAW colours, not `EffectiveQualification`: the effective verdict collapses to
 * green/red for ranking and returns `null` for an orange-only pair, a grey-only pair
 * and an unobserved pair alike. The board's Kwalificatie column and the row-existence
 * rule both need to tell those apart.
 */
export interface QualificationObservation {
  readonly trainerExternalId: string;
  readonly themaExternalId: string;
  readonly colours: readonly Qualification[];
}

/**
 * ONE observed colour for a pair, exactly as the Thema's board yields it — several rows
 * per pair when a trainer appears under more than one colour.
 *
 * Distinct from {@link QualificationObservation}, which is the grouped form the roll-up
 * works in. Keeping both means the reader hands over what it actually has and the
 * grouping happens once, in the job, rather than in every caller.
 */
export interface QualificationColour {
  readonly trainerExternalId: string;
  readonly themaExternalId: string;
  readonly colour: Qualification;
}

/** What the board's Kwalificatie column can say. */
export type BoardQualification = 'Groen' | 'Oranje' | 'Rood' | 'Grijs' | 'Conflict' | 'Geen';

/** One (trainer × thema) statistic — the desired state of one stats-board row. */
export interface TrainerThemaStatRow {
  readonly trainerExternalId: string;
  readonly themaExternalId: string;
  /** Legacy `gewogen_gemiddelde`: null when there are no evaluations, NEVER 0. */
  readonly weightedAvg: number | null;
  /** Legacy `som_evals`. A training without a parseable grade does not contribute. */
  readonly evaluationCount: number;
  /** Legacy `keer_gegeven`: +1 per completed training, per pair. */
  readonly timesTaught: number;
  readonly qualification: BoardQualification;
}
