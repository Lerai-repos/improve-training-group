/**
 * An RFC 4180 CSV parser and the CSV-backed {@link EvaluationSource}.
 *
 * Hand-rolled because the repo has no CSV dependency and the alternative is not
 * `split('\n')`: the two free-text columns in the real exports contain embedded commas
 * *and* embedded newlines, so a line-oriented reader corrupts every row after the
 * first quoted newline.
 *
 * This is the in-memory twin the ports/adapters convention asks for — the same rules
 * the Google adapter runs, exercised without a network — and it doubles as the input
 * for the dry-run before the service account exists.
 */

import { decodeGrid } from './sheets-reader';

import type { EvaluationSource, ReadResult } from './sheets-reader';
import type { SheetRef } from './types';

const QUOTE = '"';
const COMMA = ',';
const CR = '\r';
const LF = '\n';

/**
 * Parse CSV text into a grid of raw cells.
 *
 * Handles quoted fields containing commas, newlines and doubled quotes, plus CRLF and
 * a missing trailing newline. Rows are NOT padded here — that is `decodeGrid`'s job,
 * because the Sheets API is ragged in the same way and both inputs must behave alike.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === QUOTE) {
        if (text[i + 1] === QUOTE) {
          field += QUOTE;
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === QUOTE && field === '') {
      quoted = true;
      started = true;
      continue;
    }
    if (char === COMMA) {
      endField();
      started = true;
      continue;
    }
    if (char === CR) {
      // Swallow CR; the LF that follows ends the row. A lone CR also ends it.
      if (text[i + 1] === LF) {
        i += 1;
      }
      endRow();
      continue;
    }
    if (char === LF) {
      endRow();
      continue;
    }
    field += char;
    started = true;
  }

  // A trailing newline leaves nothing pending; anything else is a final row.
  if (started || field !== '' || row.length > 0) {
    endRow();
  }

  return rows;
}

export interface CsvInput {
  readonly text: string;
  readonly source: SheetRef;
}

/**
 * An {@link EvaluationSource} over in-memory CSV text.
 *
 * `async` rather than a `Promise.resolve` of a synchronous body: `decodeGrid` throws on
 * an unreadable header, and a synchronous throw out of a Promise-returning method
 * escapes any `.catch()` the caller attached. The contract is "it rejects", so it has
 * to actually reject.
 */
export function csvEvaluationSource(inputs: readonly CsvInput[]): EvaluationSource {
  return {
    async readResponses(): Promise<ReadResult> {
      const decoded = inputs.map((input) => decodeGrid(parseCsv(input.text), input.source));
      return {
        responses: decoded.flatMap((d) => d.responses),
        sheets: decoded.map((d) => d.summary),
      };
    },
  };
}
