import { describe, expect, it } from 'vitest';

import { csvEvaluationSource, parseCsv } from '../csv-source';
import { decodeGrid, sheetValuesSchema } from '../sheets-reader';

import type { SheetRef } from '../types';

const SOURCE: SheetRef = { documentId: 'doc', sheetName: 'Formulierreacties 1', label: 'nl' };

const HEADER = ['Tijdstempel', 'Code', 'Welk eindcijfer zou je de sessie geven?'];

const grid = (...rows: string[][]): string[][] => [HEADER, ...rows];

describe('parseCsv', () => {
  it('parses a quoted field containing a comma', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
  });

  /** Real NL free-text answers contain newlines; a line-oriented reader corrupts them. */
  it('parses a quoted field containing a newline', () => {
    expect(parseCsv('a,"line1\nline2",c')).toEqual([['a', 'line1\nline2', 'c']]);
  });

  it('parses a doubled quote inside a quoted field', () => {
    expect(parseCsv('a,"he said ""hi""",c')).toEqual([['a', 'he said "hi"', 'c']]);
  });

  it('handles CRLF', () => {
    expect(parseCsv('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('handles a missing trailing newline and does not invent an extra row for one', () => {
    expect(parseCsv('a,b\nc,d')).toHaveLength(2);
    expect(parseCsv('a,b\nc,d\n')).toHaveLength(2);
  });

  it('keeps an empty row as an empty field rather than dropping it', () => {
    expect(parseCsv('a,b\n,\nc,d')).toEqual([
      ['a', 'b'],
      ['', ''],
      ['c', 'd'],
    ]);
  });
});

describe('decodeGrid', () => {
  describe('which rows count', () => {
    /**
     * The sharp version of the trap. The NL export's blank rows are NOT trailing: there
     * are two interior blocks with 25 real responses after them. A reader that stops at
     * the first blank row loses those without a word.
     */
    it('keeps the responses that follow an interior blank block', () => {
      const decoded = decodeGrid(
        grid(
          ['11-3-2025 13:54:46', 'C17', '7'],
          ['', '', ''],
          ['', '', ''],
          ['6-5-2026 13:00:40', '260546', '8'],
          ['', '', ''],
          ['7-7-2026 15:12:12', '260705', '9']
        ),
        SOURCE
      );

      expect(decoded.responses.map((r) => r.rawCode)).toEqual(['C17', '260546', '260705']);
      expect(decoded.summary.blankRows).toBe(3);
    });

    it('skips a row whose cells are only whitespace', () => {
      const decoded = decodeGrid(grid(['   ', '  ', ' ']), SOURCE);

      expect(decoded.responses).toHaveLength(0);
      expect(decoded.summary.blankRows).toBe(1);
    });

    it('numbers rows as the SHEET does, so a report can point at one', () => {
      const decoded = decodeGrid(grid(['t', 'A1', '8'], ['', '', ''], ['t', 'A2', '8']), SOURCE);

      // Header is row 1, so the first data row is row 2 and the third is row 4.
      expect(decoded.responses.map((r) => r.rowNumber)).toEqual([2, 4]);
    });

    it('accounts for every row: total = blank + responses', () => {
      const decoded = decodeGrid(
        grid(['t', 'A1', '8'], ['', '', ''], ['t', '', ''], ['', '', '']),
        SOURCE
      );

      expect(decoded.summary.totalRows).toBe(
        decoded.summary.blankRows + decoded.summary.responses
      );
    });
  });

  describe('the timestamp is never parsed', () => {
    /**
     * Fourteen real NL rows carry `1`…`14` instead of a date — paper evaluations typed
     * in by hand. Any date validation on that column deletes them behind a green run.
     */
    it('keeps rows whose Tijdstempel is a sequence number', () => {
      const decoded = decodeGrid(grid(['1', '260412', '8'], ['14', '260412', '9']), SOURCE);

      expect(decoded.responses).toHaveLength(2);
      expect(decoded.responses[0].receivedAtRaw).toBe('1');
    });

    it('keeps a row with no timestamp at all', () => {
      const decoded = decodeGrid(grid(['', 'C17', '7']), SOURCE);

      expect(decoded.responses).toHaveLength(1);
      expect(decoded.responses[0].receivedAtRaw).toBeNull();
    });
  });

  describe('codes and grades', () => {
    /** The Sheets API omits trailing empty cells, so a row can be short. */
    it('pads a short row instead of throwing', () => {
      const decoded = decodeGrid(grid(['11-3-2025', 'C17']), SOURCE);

      expect(decoded.responses[0].rawCode).toBe('C17');
      expect(decoded.responses[0].grade).toBeNull();
    });

    it('carries the code verbatim, trailing space included', () => {
      const decoded = decodeGrid(grid(['t', 'E19 ', '8']), SOURCE);

      // Normalisation is attribute.ts's job; the reader must not pre-empt it.
      expect(decoded.responses[0].rawCode).toBe('E19 ');
    });

    /** 13 real NL rows. Legacy counts them, so they must survive as responses. */
    it('keeps a row with a blank grade, as a response with grade null', () => {
      const decoded = decodeGrid(grid(['t', 'C17', '']), SOURCE);

      expect(decoded.responses).toHaveLength(1);
      expect(decoded.responses[0].grade).toBeNull();
      expect(decoded.summary.unparseableGrades).toBe(0);
    });

    it('keeps a row with an unparseable grade and records one anomaly', () => {
      const decoded = decodeGrid(grid(['t', 'C18', 'E']), SOURCE);

      expect(decoded.responses).toHaveLength(1);
      expect(decoded.responses[0].grade).toBeNull();
      expect(decoded.summary.unparseableGrades).toBe(1);
      expect(decoded.summary.anomalies[0]).toMatchObject({ kind: 'unparseable', raw: 'E' });
    });

    /**
     * Legacy's `Number()` is unbounded. Rejecting an out-of-range grade would move our
     * averages away from the parity corpus for a case that has never occurred, so it is
     * reported and kept.
     */
    it('keeps an out-of-range grade and reports it', () => {
      const decoded = decodeGrid(grid(['t', 'C17', '42']), SOURCE);

      expect(decoded.responses[0].grade).toBe(42);
      expect(decoded.summary.anomalies[0]).toMatchObject({ kind: 'out_of_range', raw: '42' });
    });

    it('reads a blank code as a response and counts it', () => {
      const decoded = decodeGrid(grid(['t', '', '8']), SOURCE);

      expect(decoded.responses).toHaveLength(1);
      expect(decoded.summary.blankCodeRows).toBe(1);
    });
  });

  describe('refusing an unreadable sheet', () => {
    it('throws, naming the sheet, when the header cannot be resolved', () => {
      expect(() => decodeGrid([['Tijdstempel', 'Iets', 'Anders']], SOURCE)).toThrow(/nl.*doc/s);
    });

    it('throws on a sheet with no header row at all', () => {
      expect(() => decodeGrid([], SOURCE)).toThrow(/empty/);
    });
  });
});

describe('sheetValuesSchema', () => {
  it('accepts a ragged payload — the API omits trailing empty cells', () => {
    const parsed = sheetValuesSchema.parse({
      range: 'A1:Q100',
      majorDimension: 'ROWS',
      values: [['a', 'b', 'c'], ['a']],
    });

    expect(parsed.values?.[1]).toEqual(['a']);
  });

  it('accepts an empty tab, where values is absent', () => {
    expect(sheetValuesSchema.parse({ range: 'A1:Q100' }).values).toBeUndefined();
  });

  it('rejects an unexpected key rather than ignoring it', () => {
    expect(() => sheetValuesSchema.parse({ range: 'A1', surprise: 1 })).toThrow();
  });
});

describe('csvEvaluationSource', () => {
  it('reads every configured document into one list, with a summary each', async () => {
    const source = csvEvaluationSource([
      { text: 'Tijdstempel,Code,Eindcijfer\nt,A1,8\n', source: SOURCE },
      {
        text: 'Tijdstempel,Code,Eindcijfer\nt,B1,9\n',
        source: { documentId: 'doc2', sheetName: 'Sheet1', label: 'en' },
      },
    ]);

    const result = await source.readResponses();

    expect(result.responses.map((r) => r.rawCode)).toEqual(['A1', 'B1']);
    expect(result.sheets.map((s) => s.source.label)).toEqual(['nl', 'en']);
  });

  it('propagates an unreadable header as a throw, never as zero responses', async () => {
    const source = csvEvaluationSource([{ text: 'a,b,c\n1,2,3\n', source: SOURCE }]);

    await expect(source.readResponses()).rejects.toThrow();
  });
});
