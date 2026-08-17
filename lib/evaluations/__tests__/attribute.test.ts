import { describe, expect, it } from 'vitest';

import { attributeResponses, normalizeCode, splitIeCodes } from '../attribute';

import type { EvaluationResponse, SheetRef, TrainingRef } from '../types';

const SOURCE: SheetRef = { documentId: 'doc', sheetName: 'tab', label: 'nl' };

let nextRow = 2;
const response = (rawCode: string, grade: number | null = 8): EvaluationResponse => {
  nextRow += 1;
  return { source: SOURCE, rowNumber: nextRow, rawCode, grade, receivedAtRaw: 't' };
};

const training = (
  id: string,
  rawIeCode: string | null,
  clientKey: string | null = `client-${id}`,
  themaKey: string | null = `thema-${id}`
): TrainingRef => ({
  trainingItemId: id,
  rawIeCode,
  clientKey,
  themaKey,
});

/** Two Monday items that ARE one session: one client, one course, one code. */
const sameSession = (ids: readonly string[], code: string): TrainingRef[] =>
  ids.map((id) => training(id, code, 'klant-A', 'thema-1'));

/** The ledger's whole purpose: nothing may vanish between the two sides. */
function expectFullyAccounted(result: ReturnType<typeof attributeResponses>): void {
  const lost = result.report.losses.reduce((sum, l) => sum + l.responseCount, 0);
  expect(result.report.attributedResponses + lost).toBe(result.report.totalResponses);
}

describe('normalizeCode', () => {
  it('trims, exactly like legacy Flow 9', () => {
    expect(normalizeCode('  E19 ')).toBe('E19');
  });

  it('does not fold case', () => {
    expect(normalizeCode('f68')).toBe('f68');
  });
});

describe('splitIeCodes', () => {
  it('splits on the literal ", " — the Flow 4 separator', () => {
    expect(splitIeCodes('E60GE, E60LE, E60CE')).toEqual(['E60GE', 'E60LE', 'E60CE']);
  });

  it('does not split on a bare comma, a semicolon or " en "', () => {
    expect(splitIeCodes('E60GE,E60LE')).toEqual(['E60GE,E60LE']);
    expect(splitIeCodes('E60GE; E60LE')).toEqual(['E60GE; E60LE']);
    expect(splitIeCodes('E60GE en E60LE')).toEqual(['E60GE en E60LE']);
  });

  it('treats a null or blank cell as no codes', () => {
    expect(splitIeCodes(null)).toEqual([]);
    expect(splitIeCodes('   ')).toEqual([]);
  });
});

describe('attributeResponses', () => {
  describe('matching', () => {
    it('attributes a response to the single training claiming its code', () => {
      const result = attributeResponses([response('C17')], [training('t1', 'C17')]);

      expect(result.aggregates).toEqual([
        { trainingItemId: 't1', avgOverallGrade: 8, evaluationCount: 1, matchedCodes: ['C17'] },
      ]);
      expectFullyAccounted(result);
    });

    /** `E19 ` is a real value in the export; legacy trims both sides. */
    it('matches a sheet code with a trailing space to a clean training code', () => {
      const result = attributeResponses([response('E19 ')], [training('t1', 'E19')]);

      expect(result.aggregates[0].evaluationCount).toBe(1);
    });

    it('attributes every code of a multi-code training to that one training', () => {
      const result = attributeResponses(
        [response('E60GE'), response('E60LE'), response('E60CE')],
        [training('t1', 'E60GE, E60LE, E60CE')]
      );

      expect(result.aggregates[0].evaluationCount).toBe(3);
      expect(result.aggregates[0].matchedCodes).toEqual(['E60CE', 'E60GE', 'E60LE']);
    });

    /**
     * Case-sensitivity is a decision, not an oversight: folding buys 0,37% of responses
     * and costs the parity gate its signal. The near-miss must still be visible.
     */
    it('does NOT match "f68" to "F68", and reports it as a case-only miss', () => {
      const result = attributeResponses([response('f68')], [training('t1', 'F68')]);

      expect(result.aggregates).toEqual([]);
      expect(result.report.losses).toEqual([
        expect.objectContaining({
          kind: 'case_only_miss',
          code: 'f68',
          responseCount: 1,
          candidateTrainingIds: ['t1'],
        }),
      ]);
      expectFullyAccounted(result);
    });

    it('reports a code no training claims as unknown, not as a case miss', () => {
      const result = attributeResponses([response('Carlijn')], [training('t1', 'F68')]);

      expect(result.report.losses[0]).toMatchObject({ kind: 'unknown_code', code: 'Carlijn' });
    });
  });

  describe('counts and averages', () => {
    /**
     * The measured legacy shape (training 251010: 25 rows, 24 grades, 8.33). The count
     * is `matches.length`; the average skips the ungraded row. Both sides of that
     * asymmetry are load-bearing for parity.
     */
    it('counts matched rows including blank grades, while the average skips them', () => {
      const result = attributeResponses(
        [response('C17', 8), response('C17', 9), response('C17', null)],
        [training('t1', 'C17')]
      );

      expect(result.aggregates[0].evaluationCount).toBe(3);
      expect(result.aggregates[0].avgOverallGrade).toBe(8.5);
    });

    it('rounds the average to 2 decimals at training level, as Airtable does', () => {
      const result = attributeResponses(
        [response('C17', 8), response('C17', 9), response('C17', 9)],
        [training('t1', 'C17')]
      );

      // 26/3 = 8.6666… → 8.67
      expect(result.aggregates[0].avgOverallGrade).toBe(8.67);
    });

    /**
     * No such training exists in the corpus, so the corpus cannot decide it. Pinned from
     * the calc layer's own semantics: responses without a grade are still responses.
     */
    it('gives a training whose grades are all blank a null average and a real count', () => {
      const result = attributeResponses(
        [response('C17', null), response('C17', null)],
        [training('t1', 'C17')]
      );

      expect(result.aggregates[0]).toMatchObject({ avgOverallGrade: null, evaluationCount: 2 });
    });
  });

  describe('the loss ledger', () => {
    it('attributes an ambiguous code to neither training and names both', () => {
      const result = attributeResponses(
        [response('260204'), response('260204')],
        [training('t1', '260204', 'Pon'), training('t2', '260204', 'NWO')]
      );

      expect(result.aggregates).toEqual([]);
      expect(result.report.losses[0]).toMatchObject({
        kind: 'ambiguous_code',
        responseCount: 2,
        candidateTrainingIds: ['t1', 't2'],
        distinctClients: 2,
      });
      expect(result.report.trainingsWithAmbiguousCode).toEqual(['t1', 't2']);
      expectFullyAccounted(result);
    });

    /**
     * Two buckets hide in the spec's single 358 figure: 32 cross-client codes (282
     * responses) and 30 same-client ones (112). A client reusing a code across a series
     * is a different conversation with ITG than two unrelated clients colliding.
     */
    /**
     * The live Agenda reader supplies no client key, and a fallback to the training id
     * would make every candidate its own "client" — reporting every collision as
     * cross-client, including the ones we know are one client reusing a code.
     */
    it('reports the classification as unknown when no client key is available', () => {
      const result = attributeResponses(
        [response('260204')],
        [
          { trainingItemId: 't1', rawIeCode: '260204', clientKey: null, themaKey: 'a' },
          { trainingItemId: 't2', rawIeCode: '260204', clientKey: null, themaKey: 'b' },
        ]
      );

      expect(result.report.losses[0]).toMatchObject({
        kind: 'ambiguous_code',
        distinctClients: null,
      });
    });

    it('does not classify from a partial client key either', () => {
      const result = attributeResponses(
        [response('260204')],
        [
          { trainingItemId: 't1', rawIeCode: '260204', clientKey: 'Pon', themaKey: 'a' },
          { trainingItemId: 't2', rawIeCode: '260204', clientKey: null, themaKey: 'b' },
        ]
      );

      expect(result.report.losses[0].distinctClients).toBeNull();
    });

    /**
     * ITG gives one code to several Monday items ON PURPOSE when they are the same
     * session — a course repeated for one client, or a group split between two trainers.
     * Those responses belong to every one of those trainings, which is also what legacy
     * did (`WE Fashion=30|30|30`).
     */
    it('attributes a shared code to every training when it is one session', () => {
      const result = attributeResponses(
        [response('251050'), response('251050'), response('251050')],
        sameSession(['t1', 't2', 't3'], '251050')
      );

      expect(result.report.losses).toEqual([]);
      expect(result.aggregates.map((a) => a.trainingItemId)).toEqual(['t1', 't2', 't3']);
      for (const aggregate of result.aggregates) {
        expect(aggregate.evaluationCount).toBe(3);
      }
      expectFullyAccounted(result);
    });

    /**
     * The ledger invariant is the reason this counts responses and not (response ×
     * training) pairs: three responses over three trainings is still three responses.
     */
    it('counts a shared code once, not once per training', () => {
      const result = attributeResponses(
        [response('251050'), response('251050'), response('251050')],
        sameSession(['t1', 't2', 't3'], '251050')
      );

      expect(result.report.attributedResponses).toBe(3);
      expectFullyAccounted(result);
    });

    /**
     * Two of the thirteen genuine groups have DIFFERENT trainers — that is the
     * co-delivery case, and requiring the same trainer would throw those away.
     */
    it('does not care whether the trainers differ', () => {
      const result = attributeResponses([response('251050')], sameSession(['t1', 't2'], '251050'));

      expect(result.report.losses).toEqual([]);
      expect(result.aggregates).toHaveLength(2);
    });

    /** Different klant is the collision: nothing links them but a hand-typed number. */
    it('still refuses a shared code across two clients', () => {
      const result = attributeResponses(
        [response('260204')],
        [training('t1', '260204', 'Pon Holding', 'thema-1'), training('t2', '260204', 'NWO', 'thema-1')]
      );

      expect(result.report.losses[0]).toMatchObject({ kind: 'ambiguous_code', distinctClients: 2 });
      expect(result.aggregates).toEqual([]);
      expectFullyAccounted(result);
    });

    /**
     * One client running two DIFFERENT courses under one code is genuinely ambiguous —
     * the responses could be about either. Klant alone would wave this through.
     */
    it('refuses one client’s two different courses under one code', () => {
      const result = attributeResponses(
        [response('E33')],
        [training('t1', 'E33', 'klant-A', 'thema-1'), training('t2', 'E33', 'klant-A', 'thema-2')]
      );

      expect(result.report.losses[0]).toMatchObject({ kind: 'ambiguous_code' });
      expect(result.aggregates).toEqual([]);
    });

    /** Unknown is never "the same" — an empty klant link must not merge two trainings. */
    it('refuses when the klant link is empty on both', () => {
      const result = attributeResponses(
        [response('260204')],
        [training('t1', '260204', null, 'thema-1'), training('t2', '260204', null, 'thema-1')]
      );

      expect(result.report.losses[0]).toMatchObject({ kind: 'ambiguous_code' });
      expect(result.aggregates).toEqual([]);
    });

    it('marks a same-client collision with distinctClients 1', () => {
      const result = attributeResponses(
        [response('E33')],
        [training('t1', 'E33', 'Rabobank'), training('t2', 'E33', 'Rabobank')]
      );

      expect(result.report.losses[0]).toMatchObject({
        kind: 'ambiguous_code',
        distinctClients: 1,
      });
    });

    it('reports an unknown code once with its total, not once per response', () => {
      const result = attributeResponses(
        [response('XXX'), response('XXX'), response('XXX')],
        [training('t1', 'C17')]
      );

      expect(result.report.losses).toHaveLength(1);
      expect(result.report.losses[0]).toMatchObject({ kind: 'unknown_code', responseCount: 3 });
    });

    it('reports a blank code as its own bucket', () => {
      const result = attributeResponses([response('')], [training('t1', 'C17')]);

      expect(result.report.losses[0]).toMatchObject({ kind: 'blank_code', responseCount: 1 });
      expectFullyAccounted(result);
    });

    it('caps the sample rows so a large bucket cannot become a log dump', () => {
      const many = Array.from({ length: 40 }, () => response('XXX'));

      const result = attributeResponses(many, [training('t1', 'C17')]);

      expect(result.report.losses[0].responseCount).toBe(40);
      expect(result.report.losses[0].sampleRows.length).toBeLessThanOrEqual(5);
    });

    it('accounts for every response across a mix of every loss kind', () => {
      const result = attributeResponses(
        [
          response('C17'),
          response('f68'),
          response('XXX'),
          response(''),
          response('260204'),
          response('260204'),
        ],
        [
          training('t1', 'C17'),
          training('t2', 'F68'),
          training('t3', '260204', 'Pon'),
          training('t4', '260204', 'NWO'),
        ]
      );

      expect(result.report.totalResponses).toBe(6);
      expect(result.report.attributedResponses).toBe(1);
      expectFullyAccounted(result);
    });
  });

  describe('training-side reporting', () => {
    it('counts a training without an IE-code and produces no aggregate for it', () => {
      const result = attributeResponses([response('C17')], [training('t1', 'C17'), training('t2', null)]);

      expect(result.report.trainingsWithoutCode).toBe(1);
      expect(result.aggregates.map((a) => a.trainingItemId)).toEqual(['t1']);
    });

    it('counts trainings that received nothing', () => {
      const result = attributeResponses([response('C17')], [training('t1', 'C17'), training('t2', 'D21')]);

      expect(result.report.trainingsWithoutResponses).toBe(1);
    });

    it('dedupes a code repeated on one training and reports it', () => {
      const result = attributeResponses([response('C17')], [training('t1', 'C17, C17')]);

      expect(result.report.duplicateCodesOnTraining).toEqual(['t1']);
      // Deduped, so it is still a single claimant rather than a self-collision.
      expect(result.aggregates[0].evaluationCount).toBe(1);
    });

    it('sorts aggregates by training id, so the dry-run diff is stable', () => {
      const result = attributeResponses(
        [response('B'), response('A'), response('C')],
        [training('t3', 'C'), training('t1', 'A'), training('t2', 'B')]
      );

      expect(result.aggregates.map((a) => a.trainingItemId)).toEqual(['t1', 't2', 't3']);
    });
  });
});
