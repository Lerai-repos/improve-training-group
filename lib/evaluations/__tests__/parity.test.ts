import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { computeTrainerThemaStats } from '../stats';
import { KNOWN_TIMES_GIVEN_DIFFS, runTierA } from '../tier-a';

import type { TrainingAggregate, TrainingHistoryEntry } from '../types';

/**
 * THE DELIVERY GATE: our roll-up must reproduce Airtable's `Trainer Thema Stats`.
 *
 * Two tiers, because they answer different questions.
 *
 * **Tier A** feeds the roll-up Airtable's OWN per-training aggregates and its OWN
 * completion signal, so the only thing under test is our arithmetic. It is exact, and
 * every deviation is either a named Airtable defect or our bug. This is the gate.
 *
 * **Tier B** (CSV → per-training, elsewhere) mixes our formula with source drift — all
 * of 2024, a third sheet we do not have, responses arriving after the snapshot — so it
 * is asserted as *classified*, never as equal.
 *
 * Tier A runs twice: over a committed sanitized slice, which runs everywhere including
 * CI, and over the full gitignored snapshot when it is present. The committed half
 * exists because `describe.skipIf` on the only check of the delivery arithmetic means a
 * green pipeline proves nothing.
 *
 * WHAT THIS GATE CANNOT SEE, measured rather than assumed: 519 Airtable trainings carry
 * `Evaluation count > 0` and **not one** of them has `Avg Overall grade == 0`. So a
 * training with responses but no parseable grade does not exist in the corpus, and
 * summing every row's count is indistinguishable here from summing only the rows that
 * fed the average — a mutation swapping `contributingEvaluations` for a raw sum passes
 * every assertion below. That case is real in the sheets (13 blank grades) and is
 * guarded by `stats.test.ts` › "excludes an ungraded training from the evaluation
 * count" and `weighted-avg.test.ts`. Parity and unit tests cover different halves;
 * neither is redundant.
 */

const FIXTURE = join(__dirname, 'fixtures', 'tier-a.golden.json');
const SNAPSHOT_DIR = join(process.cwd(), 'snapshots', 'airtable');

/**
 * Tier A isolates the formula, so completion comes from Airtable's `Afgerond` rather
 * than from our date rule. These two sentinels drive `isCompleted` to the answer
 * Airtable already gave.
 */
const PAST = '2000-01-01';
const FUTURE = '2999-01-01';
const TODAY = '2026-01-01';

interface GoldenTraining {
  trainingItemId: string;
  trainerExternalIds: string[];
  themaExternalIds: string[];
  avgOverallGrade: number | null;
  evaluationCount: number;
}

interface GoldenExpectation {
  trainerExternalId: string;
  themaExternalId: string;
  weightedAvg: number | null;
  evaluationCount: number;
  timesTaught: number;
  /** Non-null when Airtable is known to be wrong here — see the extractor. */
  knownDiff: 'stale' | 'counts_unfinished' | null;
}

interface Golden {
  trainings: GoldenTraining[];
  expected: GoldenExpectation[];
}

/** Both tiers build the same two inputs; only where they come from differs. */
function rollUp(trainings: readonly GoldenTraining[]) {
  const history: TrainingHistoryEntry[] = trainings.map((t) => ({
    trainingItemId: t.trainingItemId,
    datum: PAST,
    trainerExternalIds: t.trainerExternalIds,
    themaExternalIds: t.themaExternalIds,
  }));
  const aggregates: TrainingAggregate[] = trainings
    .filter((t) => t.evaluationCount > 0)
    .map((t) => ({
      trainingItemId: t.trainingItemId,
      avgOverallGrade: t.avgOverallGrade,
      evaluationCount: t.evaluationCount,
      matchedCodes: [],
    }));

  const result = computeTrainerThemaStats({ history, aggregates, qualifications: [], today: TODAY });
  return new Map(result.rows.map((r) => [`${r.trainerExternalId}|${r.themaExternalId}`, r]));
}

describe('Tier A parity — the committed golden slice', () => {
  const golden: Golden = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const ours = rollUp(golden.trainings);

  it('covers every shape the arithmetic has to get right', () => {
    // A slice that lost its weighted cases would pass while proving nothing.
    expect(golden.expected.length).toBeGreaterThanOrEqual(50);
    expect(golden.expected.filter((e) => e.evaluationCount > 0).length).toBeGreaterThan(20);
    expect(golden.expected.filter((e) => e.evaluationCount === 0).length).toBeGreaterThan(5);
    expect(golden.expected.filter((e) => e.knownDiff !== null)).toHaveLength(5);
  });

  it('produces a row for every expected pair', () => {
    const missing = golden.expected.filter(
      (e) => !ours.has(`${e.trainerExternalId}|${e.themaExternalId}`)
    );
    expect(missing).toEqual([]);
  });

  it('reproduces Weighted Avg exactly', () => {
    const diffs = golden.expected.flatMap((e) => {
      const mine = ours.get(`${e.trainerExternalId}|${e.themaExternalId}`);
      return mine?.weightedAvg === e.weightedAvg
        ? []
        : [`${e.trainerExternalId}/${e.themaExternalId}: ${e.weightedAvg} vs ${mine?.weightedAvg}`];
    });
    expect(diffs).toEqual([]);
  });

  it('reproduces Total Evalutions exactly', () => {
    const diffs = golden.expected.flatMap((e) => {
      const mine = ours.get(`${e.trainerExternalId}|${e.themaExternalId}`);
      return mine?.evaluationCount === e.evaluationCount
        ? []
        : [`${e.trainerExternalId}/${e.themaExternalId}: ${e.evaluationCount} vs ${mine?.evaluationCount}`];
    });
    expect(diffs).toEqual([]);
  });

  /**
   * Times Given matches everywhere except the five rows where Airtable is demonstrably
   * wrong — three whose stats row predates a completed training, two where Flow 9
   * counted a training that had not happened (its own docs call this "same-batch status
   * blindness"). The allowlist is by pair, so a NEW disagreement fails even though the
   * count of failures is unchanged.
   */
  it('reproduces Times Given except on the five known Airtable defects', () => {
    const unexplained = golden.expected.flatMap((e) => {
      const mine = ours.get(`${e.trainerExternalId}|${e.themaExternalId}`);
      const agrees = mine?.timesTaught === e.timesTaught;
      if (agrees || e.knownDiff !== null) {
        return [];
      }
      return [`${e.trainerExternalId}/${e.themaExternalId}: ${e.timesTaught} vs ${mine?.timesTaught}`];
    });
    expect(unexplained).toEqual([]);
  });

  /** An allowlisted row that started agreeing means the fixture drifted, not that we improved. */
  it('still disagrees on each allowlisted row — the allowlist is not stale', () => {
    for (const e of golden.expected.filter((x) => x.knownDiff !== null)) {
      const mine = ours.get(`${e.trainerExternalId}|${e.themaExternalId}`);
      expect(mine?.timesTaught).not.toBe(e.timesTaught);
    }
  });
});

/**
 * The exhaustive run, over the real snapshot. Skipped on a fresh clone and in CI —
 * `snapshots/` is gitignored — which is exactly why the golden slice above exists.
 */
const hasSnapshot =
  existsSync(join(SNAPSHOT_DIR, 'trainingen.json')) &&
  existsSync(join(SNAPSHOT_DIR, 'trainer_thema_stats.json'));

interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

describe.skipIf(!hasSnapshot)('Tier A parity — the full Airtable snapshot', () => {
  const read = (name: string): AirtableRecord[] =>
    JSON.parse(readFileSync(join(SNAPSHOT_DIR, `${name}.json`), 'utf8'));
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

  const trainingen = read('trainingen');
  const stats = read('trainer_thema_stats');

  const history: TrainingHistoryEntry[] = trainingen.map((r) => ({
    trainingItemId: r.id,
    datum: r.fields.Status === 'Afgerond' ? PAST : FUTURE,
    trainerExternalIds: arr(r.fields.Trainer),
    themaExternalIds: arr(r.fields.Thema),
  }));
  const aggregates: TrainingAggregate[] = trainingen
    .filter((r) => num(r.fields['Evaluation count']) > 0)
    .map((r) => ({
      trainingItemId: r.id,
      avgOverallGrade:
        num(r.fields['Avg Overall grade']) > 0 ? num(r.fields['Avg Overall grade']) : null,
      evaluationCount: num(r.fields['Evaluation count']),
      matchedCodes: [],
    }));

  const result = computeTrainerThemaStats({ history, aggregates, qualifications: [], today: TODAY });
  const ours = new Map(result.rows.map((r) => [`${r.trainerExternalId}|${r.themaExternalId}`, r]));
  const overlapping = stats.filter((s) =>
    ours.has(`${arr(s.fields.Trainer)[0]}|${arr(s.fields.Thema)[0]}`)
  );
  const mine = (s: AirtableRecord) =>
    ours.get(`${arr(s.fields.Trainer)[0]}|${arr(s.fields.Thema)[0]}`);

  /**
   * The 1.086 Airtable rows we do not produce are ALL pure qualification rows — zero
   * trainings, zero evaluations — because this tier is run without qualifications. That
   * they are uniformly empty is what makes the overlap a fair comparison rather than a
   * convenient subset.
   */
  it('the rows we do not produce are exactly the history-less ones', () => {
    const notOurs = stats.filter((s) => mine(s) === undefined);

    expect(notOurs.length).toBeGreaterThan(0);
    expect(notOurs.filter((s) => num(s.fields['Times Given']) > 0)).toEqual([]);
    expect(notOurs.filter((s) => num(s.fields['Total Evalutions']) > 0)).toEqual([]);
  });

  it('reproduces Weighted Avg on every overlapping row', () => {
    const diffs = overlapping.flatMap((s) => {
      // Airtable has no way to say "no evaluations", so its 0 is our null.
      const theirs = num(s.fields['Weighted Avg']);
      const value = mine(s)?.weightedAvg ?? 0;
      return Math.abs(theirs - value) < 1e-9 ? [] : [`${s.id}: ${theirs} vs ${value}`];
    });
    expect(diffs).toEqual([]);
  });

  it('reproduces Total Evalutions on every overlapping row', () => {
    const diffs = overlapping.flatMap((s) =>
      num(s.fields['Total Evalutions']) === mine(s)?.evaluationCount ? [] : [s.id]
    );
    expect(diffs).toEqual([]);
  });

  it('reproduces Times Given on all but the five known Airtable defects', () => {
    const diffs = overlapping.flatMap((s) =>
      num(s.fields['Times Given']) === mine(s)?.timesTaught ? [] : [s.id]
    );
    expect(diffs.sort()).toEqual([...KNOWN_TIMES_GIVEN_DIFFS.keys()].sort());
  });

  /**
   * The SAME function the seed runs before it writes.
   *
   * A gate that exists only as a test is a gate the production path never passes
   * through — `--apply` used to publish on a row-count comparison alone, which cannot
   * see a wrong average, a wrong count, or a broken join.
   */
  it('is the gate the seed uses, and it is clean', () => {
    const result = runTierA(trainingen, stats, read('trainers'));

    expect(result.unexplained).toEqual([]);
    expect(result.compared).toBeGreaterThan(600);
    expect(result.mismatches).toHaveLength(KNOWN_TIMES_GIVEN_DIFFS.size);
    // Ranking layer 3 sorts on this; the per-theme figures can agree while it does not.
    expect(result.trainersCompared).toBeGreaterThan(50);
  });

  /**
   * The gate's fail-open shapes, checked rather than assumed. An empty or malformed
   * snapshot compares zero rows, finds zero mismatches, and would otherwise approve.
   */
  it('refuses to pass on an empty comparison set', () => {
    expect(runTierA([], [], []).unexplained.length).toBeGreaterThan(0);
    expect(runTierA(trainingen, [], []).unexplained.length).toBeGreaterThan(0);
  });

  /**
   * The row minimum says nothing about the trainer corpus: with both other snapshots
   * valid, an empty `trainers.json` compares zero trainers, raises no mismatch, and
   * would publish having never checked ranking layer 3.
   */
  it('refuses to pass without the trainer corpus', () => {
    const result = runTierA(trainingen, stats, []);

    expect(result.trainersCompared).toBe(0);
    expect(result.unexplained.some((m) => m.field === 'trainerOverall')).toBe(true);
  });

  /**
   * Parity checked only Airtable → ours would let a regression keep every expected pair
   * AND emit phantom rows, which are then published and rank.
   */
  it('reports a pair we produce that Airtable has no row for', () => {
    // Drop a row Airtable does have; our roll-up still produces the pair.
    const withHistory = stats.filter((s) => num(s.fields['Times Given']) > 0);
    const [dropped] = withHistory;
    const trimmed = stats.filter((s) => s.id !== dropped.id);

    const result = runTierA(trainingen, trimmed, read('trainers'));

    expect(result.unexplained.some((m) => m.field === 'extra')).toBe(true);
  });

  /** Full precision: the snapshot stores 7.942972972972973, not a display rounding. */
  it('compares the trainer-wide average at full precision', () => {
    const trainers = read('trainers');
    const [first] = trainers.filter((t) => num(t.fields['Overall Avg Score']) > 0);
    const nudged = trainers.map((t) =>
      t.id === first.id
        ? {
            ...t,
            fields: { ...t.fields, 'Overall Avg Score': num(t.fields['Overall Avg Score']) + 0.004 },
          }
        : t
    );

    const result = runTierA(trainingen, stats, nudged);

    expect(result.unexplained.some((m) => m.field === 'trainerOverall')).toBe(true);
  });

  /** A row Airtable has WITH history that we do not produce is a regression, not a category. */
  it('fails when an expected row goes missing', () => {
    const withHistory = stats.filter((s) => num(s.fields['Times Given']) > 0);
    const result = runTierA([], withHistory, []);

    expect(result.unexplained.some((m) => m.field === 'missing')).toBe(true);
  });

  /** Allowlisted by row AND value: a bigger discrepancy on the same row is not forgiven. */
  it('does not forgive a different discrepancy on an allowlisted row', () => {
    const [rowId] = [...KNOWN_TIMES_GIVEN_DIFFS.keys()];
    const tampered = stats.map((s) =>
      s.id === rowId ? { ...s, fields: { ...s.fields, 'Times Given': 400 } } : s
    );

    const result = runTierA(trainingen, tampered, []);

    expect(result.unexplained.some((m) => m.statsRowId === rowId)).toBe(true);
  });
});
