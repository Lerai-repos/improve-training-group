/**
 * The evaluation-response source: the port, the transport schemas, and the pure grid
 * decoder both adapters funnel through.
 *
 * FAILURE CONTRACT: `readResponses` **throws**. It never returns a partial result and
 * never returns an empty list to signal failure. Zero responses that should have been
 * thousands produces a stats board where every trainer has never been evaluated, and
 * the nightly job would then blank the corpus. There is no degraded mode here.
 */

import { z } from 'zod';

import { resolveColumns, type ResolvedColumns } from './header-map';

import type { EvaluationResponse, ResponseAnswers, SheetRef } from './types';

/** What one tab contributed, for the run log and the per-document baseline. */
export interface SheetReadSummary {
  readonly source: SheetRef;
  /** Data rows the transport returned (the header excluded). */
  readonly totalRows: number;
  /** Rows where no cell had content after trimming. */
  readonly blankRows: number;
  readonly responses: number;
  readonly blankCodeRows: number;
  readonly unparseableGrades: number;
  /**
   * Scored REPORT answers that would not parse. Counted rather than merely nulled: a
   * question whose cells stop parsing shrinks a distribution in the report, which is a
   * far quieter failure than a section going missing.
   */
  readonly unparseableAnswers: number;
  /** Which indexes were used. Printed every run — this is how a header change is noticed. */
  readonly columns: ResolvedColumns;
  readonly anomalies: readonly CellAnomaly[];
}

export interface CellAnomaly {
  readonly rowNumber: number;
  readonly field: 'grade';
  readonly kind: 'unparseable' | 'out_of_range';
  readonly raw: string;
}

export interface ReadResult {
  readonly responses: readonly EvaluationResponse[];
  readonly sheets: readonly SheetReadSummary[];
}

/**
 * The only I/O to Google. One call per execution.
 *
 * It takes no arguments on purpose: which documents to read is adapter configuration,
 * and a caller able to request a subset could produce an undetectable partial run.
 */
export interface EvaluationSource {
  readResponses(): Promise<ReadResult>;
}

/**
 * One `spreadsheets.values.get` payload.
 *
 * `values` is absent for an empty tab and **ragged**: the Sheets API omits trailing
 * empty cells, so a row can be shorter than the header. Every cell access below is
 * therefore `row[i] ?? ''`. Pin `valueRenderOption=FORMATTED_VALUE` on the request so
 * every cell really is a string.
 */
export const sheetValuesSchema = z
  .object({
    range: z.string().min(1),
    majorDimension: z.literal('ROWS').optional(),
    values: z.array(z.array(z.string())).optional(),
  })
  .strict();

/** Which documents and tabs to read. */
export const sourceConfigSchema = z.object({
  documents: z
    .array(
      z.object({
        documentId: z.string().min(1),
        sheetName: z.string().min(1),
        label: z.string().min(1),
      })
    )
    .min(1),
});

export type SourceConfig = z.infer<typeof sourceConfigSchema>;

export interface SheetDecode {
  readonly responses: readonly EvaluationResponse[];
  readonly summary: SheetReadSummary;
}

/** The header occupies sheet row 1, so grid index 0 is row 2. */
const FIRST_DATA_ROW = 2;
/** Legacy uses a bare `Number()`; these bounds only classify, they never reject. */
const GRADE_MIN = 1;
const GRADE_MAX = 10;

const cell = (row: readonly string[], index: number | null): string =>
  index === null ? '' : (row[index] ?? '');

/** A row with nothing in it at all. Skipped — never treated as the end of the data. */
function isBlankRow(row: readonly string[]): boolean {
  return !row.some((value) => value.trim() !== '');
}

/**
 * A scored cell → number.
 *
 * Same tolerance as the eindcijfer, deliberately: one decimal-comma rule for every
 * number that comes out of these forms, rather than two that can drift apart. Returns
 * `undefined` for "there was something here and it did not parse", which the caller
 * counts, versus `null` for "nothing here".
 */
function parseScore(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** What a sheet without any report columns contributes: nothing, in the right shape. */
export const EMPTY_ANSWERS: ResponseAnswers = {
  program: null,
  practical: null,
  tools: null,
  trainerExpertise: null,
  trainerCommunication: null,
  followUp: null,
  positive: null,
  improvement: null,
};

/** A free-text cell, verbatim. Blank — including whitespace only — becomes null. */
function textAnswer(raw: string): string | null {
  return raw.trim() === '' ? null : raw;
}

/**
 * Grid → responses. No I/O; both adapters funnel through this.
 *
 * Three separate predicates, and the order matters:
 *
 * 1. A row is kept when ANY cell has content. A row that fails this is **skipped, not
 *    stopped on** — the NL export has two *interior* blank blocks with 25 real
 *    responses after them, so a `trimEnd`-style reader loses those silently.
 * 2. A blank code is still a response; `attribute.ts` reports it as `blank_code`.
 * 3. A blank or unparseable grade is still a response, because legacy counts matched
 *    ROWS, not grades — 13 such rows exist in the live NL export and they are part of
 *    every `Evaluation count` Airtable holds.
 */
export function decodeGrid(
  grid: readonly (readonly string[])[],
  source: SheetRef
): SheetDecode {
  const [header, ...dataRows] = grid;
  if (header === undefined) {
    throw new Error(`${source.label}: sheet is empty — not even a header row`);
  }

  const resolution = resolveColumns(header);
  if (!resolution.ok) {
    throw new Error(
      `${source.label} (${source.documentId}/${source.sheetName}): ${resolution.reason}. ` +
        `Headers seen: ${resolution.headers.map((h) => `"${h}"`).join(', ')}`
    );
  }
  const columns = resolution.columns;

  const responses: EvaluationResponse[] = [];
  const anomalies: CellAnomaly[] = [];
  let blankRows = 0;
  let blankCodeRows = 0;
  let unparseableGrades = 0;
  let unparseableAnswers = 0;

  dataRows.forEach((row, index) => {
    if (isBlankRow(row)) {
      blankRows += 1;
      return;
    }
    const rowNumber = index + FIRST_DATA_ROW;
    const rawCode = cell(row, columns.code);
    if (rawCode.trim() === '') {
      blankCodeRows += 1;
    }

    const rawGrade = cell(row, columns.grade).trim();
    let grade: number | null = null;
    if (rawGrade !== '') {
      // Legacy uses `parseFloat`; a decimal comma has never appeared in 3.207 real
      // grades, but normalising one costs nothing and mis-reading "8,5" as 8 would not.
      const parsed = Number(rawGrade.replace(',', '.'));
      if (Number.isFinite(parsed)) {
        grade = parsed;
        if (parsed < GRADE_MIN || parsed > GRADE_MAX) {
          // Recorded, NOT dropped: legacy's `Number()` is unbounded, and rejecting here
          // would move averages away from the parity corpus for a case that has never
          // occurred.
          anomalies.push({ rowNumber, field: 'grade', kind: 'out_of_range', raw: rawGrade });
        }
      } else {
        unparseableGrades += 1;
        anomalies.push({ rowNumber, field: 'grade', kind: 'unparseable', raw: rawGrade });
      }
    }

    const score = (index: number | null): number | null => {
      const parsed = parseScore(cell(row, index));
      if (parsed === undefined) {
        unparseableAnswers += 1;
        return null;
      }
      return parsed;
    };
    const answers: ResponseAnswers = {
      program: score(columns.program),
      practical: score(columns.practical),
      tools: score(columns.tools),
      trainerExpertise: score(columns.trainerExpertise),
      trainerCommunication: score(columns.trainerCommunication),
      followUp: textAnswer(cell(row, columns.followUp)),
      positive: textAnswer(cell(row, columns.positive)),
      improvement: textAnswer(cell(row, columns.improvement)),
    };

    const timestamp = cell(row, columns.timestamp).trim();
    responses.push({
      source,
      rowNumber,
      rawCode,
      grade,
      receivedAtRaw: timestamp === '' ? null : timestamp,
      answers,
    });
  });

  return {
    responses,
    summary: {
      source,
      totalRows: dataRows.length,
      blankRows,
      responses: responses.length,
      blankCodeRows,
      unparseableGrades,
      unparseableAnswers,
      columns,
      anomalies,
    },
  };
}
