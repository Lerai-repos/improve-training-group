import { describe, expect, it } from 'vitest';

import { computeScores } from '@lib/recommend/scores';

import {
  amsterdamToday,
  boardQualification,
  computeTrainerThemaStats,
  isCompleted,
  toTrainerThemeEvals,
} from '../stats';

import type { Qualification } from '@lib/calc';
import type { QualificationObservation, TrainingAggregate, TrainingHistoryEntry } from '../types';

const TODAY = '2026-08-11';
const PAST = '2026-08-01';
const FUTURE = '2026-09-01';

const entry = (over: Partial<TrainingHistoryEntry> = {}): TrainingHistoryEntry => ({
  trainingItemId: 'tr1',
  datum: PAST,
  trainerExternalIds: ['t1'],
  themaExternalIds: ['th1'],
  ...over,
});

const aggregate = (
  trainingItemId: string,
  avgOverallGrade: number | null,
  evaluationCount: number
): TrainingAggregate => ({ trainingItemId, avgOverallGrade, evaluationCount, matchedCodes: [] });

const qual = (
  trainerExternalId: string,
  themaExternalId: string,
  colours: Qualification[]
): QualificationObservation => ({ trainerExternalId, themaExternalId, colours });

const run = (over: Partial<Parameters<typeof computeTrainerThemaStats>[0]> = {}) =>
  computeTrainerThemaStats({
    history: [],
    aggregates: [],
    qualifications: [],
    today: TODAY,
    ...over,
  });

describe('amsterdamToday', () => {
  /** 22:30Z in August is 00:30 the next day in Amsterdam (CEST, UTC+2). */
  it('is CEST-correct', () => {
    expect(amsterdamToday(new Date('2026-08-11T22:30:00Z'))).toBe('2026-08-12');
  });

  /** 23:30Z in January is 00:30 the next day in Amsterdam (CET, UTC+1). */
  it('is CET-correct', () => {
    expect(amsterdamToday(new Date('2026-01-11T23:30:00Z'))).toBe('2026-01-12');
  });

  it('has not rolled over yet at 21:30Z in summer', () => {
    expect(amsterdamToday(new Date('2026-08-11T21:30:00Z'))).toBe('2026-08-11');
  });
});

describe('isCompleted', () => {
  it('counts yesterday but not today — the training has not happened yet', () => {
    expect(isCompleted('2026-08-10', TODAY)).toBe(true);
    expect(isCompleted(TODAY, TODAY)).toBe(false);
  });

  it('does not count an undated training', () => {
    expect(isCompleted(null, TODAY)).toBe(false);
  });

  it('reads a datetime by its date part', () => {
    expect(isCompleted('2026-08-10T09:00:00', TODAY)).toBe(true);
  });
});

describe('boardQualification', () => {
  it.each<[Qualification[], string]>([
    [['groen'], 'Groen'],
    [['oranje'], 'Oranje'],
    [['rood'], 'Rood'],
    [['grijs'], 'Grijs'],
    [[], 'Geen'],
  ])('labels %s as %s', (colours, expected) => {
    expect(boardQualification(colours)).toBe(expected);
  });

  it('calls two rival assessed colours a Conflict', () => {
    expect(boardQualification(['groen', 'rood'])).toBe('Conflict');
  });

  /**
   * ITG's 30-July migration left trainers listed in grijs alongside their new colour.
   * Treating grijs as a rival turned ~380 pairs into conflicts once already.
   */
  it('does not treat grijs as a rival opinion', () => {
    expect(boardQualification(['groen', 'grijs'])).toBe('Groen');
  });
});

describe('computeTrainerThemaStats', () => {
  describe('the counting rule', () => {
    /** Legacy's shape, verified on 1.760 of 1.765 real Airtable rows. */
    it('a 2-trainer × 2-thema training touches four pairs and adds 1 to each', () => {
      const result = run({
        history: [entry({ trainerExternalIds: ['t1', 't2'], themaExternalIds: ['th1', 'th2'] })],
      });

      expect(result.rows).toHaveLength(4);
      expect(result.rows.every((r) => r.timesTaught === 1)).toBe(true);
    });

    /**
     * Guards the trap the spec's wording invites. "Count trainings, not
     * theme-instances" is a VIEW rule; dividing or deduping here would put the board out
     * of step with Airtable's `Times Given` and make the parity gate unusable.
     */
    it('keeps timesTaught per pair — the dedup rule lives in the view, not here', () => {
      const result = run({
        history: [
          entry({ trainingItemId: 'a', themaExternalIds: ['th1', 'th2'] }),
          entry({ trainingItemId: 'b', themaExternalIds: ['th1'] }),
        ],
      });

      const byTheme = new Map(result.rows.map((r) => [r.themaExternalId, r.timesTaught]));
      expect(byTheme.get('th1')).toBe(2);
      expect(byTheme.get('th2')).toBe(1);
    });

    it('does not count a future or an undated training', () => {
      const result = run({
        history: [
          entry({ trainingItemId: 'a', datum: FUTURE }),
          entry({ trainingItemId: 'b', datum: null }),
        ],
      });

      expect(result.rows).toEqual([]);
      expect(result.report).toMatchObject({ skippedFuture: 1, skippedUndated: 1, completed: 0 });
    });
  });

  describe('the averages', () => {
    it('weights by evaluation count across a pair’s trainings', () => {
      const result = run({
        history: [
          entry({ trainingItemId: 'a' }),
          entry({ trainingItemId: 'b' }),
        ],
        aggregates: [aggregate('a', 8, 10), aggregate('b', 6, 2)],
      });

      expect(result.rows[0]).toMatchObject({ weightedAvg: 7.67, evaluationCount: 12 });
    });

    it('is null, never 0, when a pair has trainings but no evaluations', () => {
      const result = run({ history: [entry()] });

      expect(result.rows[0]).toMatchObject({ weightedAvg: null, evaluationCount: 0, timesTaught: 1 });
    });

    /** The shared predicate: a training with no parseable grade fed neither side. */
    it('excludes an ungraded training from the evaluation count', () => {
      const result = run({
        history: [entry({ trainingItemId: 'a' }), entry({ trainingItemId: 'b' })],
        aggregates: [aggregate('a', 8, 4), aggregate('b', null, 96)],
      });

      expect(result.rows[0]).toMatchObject({ weightedAvg: 8, evaluationCount: 4 });
    });
  });

  describe('which pairs get a row', () => {
    /** The planner's most-asked distinction: green but never taught vs no data. */
    it('gives a groen pair with zero trainings a row', () => {
      const result = run({ qualifications: [qual('t1', 'th1', ['groen'])] });

      expect(result.rows[0]).toMatchObject({
        timesTaught: 0,
        weightedAvg: null,
        evaluationCount: 0,
        qualification: 'Groen',
      });
      expect(result.report.rowsFromQualificationOnly).toBe(1);
    });

    /**
     * `deriveEffective(['oranje'])` is null, exactly like grey and like nothing at all.
     * Anything keyed on it drops every orange pair without a word.
     */
    it('gives an oranje-only pair with no history a row', () => {
      const result = run({ qualifications: [qual('t1', 'th1', ['oranje'])] });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].qualification).toBe('Oranje');
    });

    it('gives a grijs-only pair with no history NO row — grijs is not a qualification', () => {
      const result = run({ qualifications: [qual('t1', 'th1', ['grijs'])] });

      expect(result.rows).toEqual([]);
    });

    it('gives a rood-only pair with no history no row either', () => {
      const result = run({ qualifications: [qual('t1', 'th1', ['rood'])] });

      expect(result.rows).toEqual([]);
    });

    /** History outlives a qualification change: "wel gegeven, nu rood" keeps its numbers. */
    it('keeps a rood pair that HAS history, with its figures intact', () => {
      const result = run({
        history: [entry()],
        aggregates: [aggregate('tr1', 8, 5)],
        qualifications: [qual('t1', 'th1', ['rood'])],
      });

      expect(result.rows[0]).toMatchObject({
        qualification: 'Rood',
        timesTaught: 1,
        weightedAvg: 8,
      });
    });

    it('labels a pair with history but no observation as Geen', () => {
      expect(run({ history: [entry()] }).rows[0].qualification).toBe('Geen');
    });
  });

  describe('incomplete trainings', () => {
    it('counts a completed training with a trainer but no thema, and makes no pair', () => {
      const result = run({ history: [entry({ themaExternalIds: [] })] });

      expect(result.rows).toEqual([]);
      expect(result.report).toMatchObject({ completed: 1, skippedNoThema: 1 });
    });

    it('counts a completed training with a thema but no trainer', () => {
      const result = run({ history: [entry({ trainerExternalIds: [] })] });

      expect(result.report).toMatchObject({ completed: 1, skippedNoTrainer: 1 });
    });
  });

  /**
   * The finding-4 alarm. Reading Agenda 2025 with the 2026 relation column ids returns
   * 202 trainerless trainings and NO error — every one of them still has responses, so
   * they all land here and the wrong column map is visible in one line.
   */
  it('names trainings whose responses reached no pair', () => {
    const result = run({
      history: [entry({ trainingItemId: 'orphan', trainerExternalIds: [] })],
      aggregates: [aggregate('orphan', 8, 3), aggregate('never-in-history', 7, 2)],
    });

    expect(result.report.aggregatesUnused).toEqual(['never-in-history', 'orphan']);
  });

  it('sorts rows by (trainer, thema)', () => {
    const result = run({
      history: [
        entry({ trainingItemId: 'a', trainerExternalIds: ['t2'], themaExternalIds: ['th2'] }),
        entry({ trainingItemId: 'b', trainerExternalIds: ['t1'], themaExternalIds: ['th2'] }),
        entry({ trainingItemId: 'c', trainerExternalIds: ['t1'], themaExternalIds: ['th1'] }),
      ],
    });

    expect(result.rows.map((r) => `${r.trainerExternalId}/${r.themaExternalId}`)).toEqual([
      't1/th1',
      't1/th2',
      't2/th2',
    ]);
  });
});

describe('toTrainerThemeEvals', () => {
  it('renames weightedAvg to avgOverallGrade and drops timesTaught', () => {
    const [projected] = toTrainerThemeEvals([
      {
        trainerExternalId: 't1',
        themaExternalId: 'th1',
        weightedAvg: 7.5,
        evaluationCount: 4,
        timesTaught: 9,
        qualification: 'Groen',
      },
    ]);

    expect(projected).toEqual({
      trainerExternalId: 't1',
      themaExternalId: 'th1',
      avgOverallGrade: 7.5,
      evaluationCount: 4,
    });
  });

  /**
   * The two-level aggregation has to be idempotent, or the board's rounding boundary
   * would move the engine's answer. This is what makes "one calc layer" checkable
   * rather than asserted.
   */
  it('round-trips: computeScores over the projection reproduces each row’s own average', () => {
    const rows = [
      {
        trainerExternalId: 't1',
        themaExternalId: 'th1',
        weightedAvg: 7.67,
        evaluationCount: 12,
        timesTaught: 2,
        qualification: 'Groen' as const,
      },
      {
        trainerExternalId: 't1',
        themaExternalId: 'th2',
        weightedAvg: 9,
        evaluationCount: 4,
        timesTaught: 1,
        qualification: 'Groen' as const,
      },
    ];

    const scores = computeScores('t1', ['th1'], toTrainerThemeEvals(rows));

    expect(scores.themeAvgScore).toBe(7.67);
    // (7.67×12 + 9×4) / 16
    expect(scores.overallAvgScore).toBeCloseTo((7.67 * 12 + 9 * 4) / 16, 10);
  });
});
