import { describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '@lib/recommend/kv';

import { DROP_FACTOR, MIN_RESPONSES, MIN_ROWS, runNightly } from '../nightly';
import { createStatsStore } from '../stats-store';

import type { AgendaHistory } from '../agenda-history';
import type { NightlyDeps } from '../nightly';
import type { EvaluationResponse, QualificationColour, SheetRef } from '../types';

/**
 * The guards, and only the guards. The chain itself is covered module by module; what
 * has to be pinned here is WHEN the job refuses to write — because the engine reads an
 * absent pair as "never taught", so a quietly-smaller run does not degrade the data, it
 * states something false about a real person until the next good run.
 */

const NOW = new Date('2026-08-12T02:45:00.000Z');
const ref = (label: string): SheetRef => ({ documentId: `doc-${label}`, sheetName: 'F1', label });

/** Enough distinct responses and pairs to clear both floors comfortably. */
function build(counts: { responses: number; trainings: number; qualPairs: number }) {
  const responses: EvaluationResponse[] = Array.from({ length: counts.responses }, (_, i) => ({
    source: ref('nl'),
    rowNumber: i + 2,
    rawCode: `IE${i % counts.trainings}`,
    grade: 8,
    receivedAtRaw: 't',
  }));

  const history: AgendaHistory = {
    trainings: Array.from({ length: counts.trainings }, (_, i) => ({
      boardId: '1',
      entry: {
        trainingItemId: `tr${i}`,
        datum: '2026-01-01',
        trainerExternalIds: [`trainer${i % 50}`],
        themaExternalIds: [`thema${i % 40}`],
      },
      ref: {
        trainingItemId: `tr${i}`,
        rawIeCode: `IE${i}`,
        clientKey: null,
        themaKey: `thema${i % 40}`,
      },
    })),
    perBoard: [{ boardId: '1', jaargang: '2026', items: counts.trainings, pages: 1 }],
  };

  const qualifications: QualificationColour[] = Array.from({ length: counts.qualPairs }, (_, i) => ({
    trainerExternalId: `q-trainer${i % 200}`,
    themaExternalId: `q-thema${i}`,
    colour: 'groen',
  }));

  return { responses, history, qualifications };
}

function deps(
  over: Partial<NightlyDeps> = {},
  fixture = build({ responses: 3_700, trainings: 1_700, qualPairs: 1_500 })
): NightlyDeps {
  const store = createStatsStore(createMemoryKvStore());
  const base: NightlyDeps = {
    source: {
      readResponses: () =>
        Promise.resolve({
          responses: fixture.responses,
          sheets: [
            {
              source: ref('nl'),
              totalRows: fixture.responses.length,
              blankRows: 0,
              responses: fixture.responses.length,
              blankCodeRows: 0,
              unparseableGrades: 0,
              columns: { code: 1, grade: 7, timestamp: 0 },
              anomalies: [],
            },
          ],
        }),
    },
    readHistory: () => Promise.resolve(fixture.history),
    readQualifications: () => Promise.resolve(fixture.qualifications),
    store,
    now: () => NOW,
  };
  return { ...base, ...over };
}

describe('runNightly', () => {
  it('computes and writes on a healthy run', async () => {
    const d = deps();

    const report = await runNightly(d, { bootstrap: true });

    expect(report.written).toBe(true);
    expect(report.refused).toBeNull();
    expect(report.rows).toBeGreaterThan(MIN_ROWS);
    expect(await d.store.read()).not.toBeNull();
  });

  it('records the source counts alongside the rows', async () => {
    const d = deps();

    await runNightly(d, { bootstrap: true });

    const snapshot = await d.store.read();
    expect(snapshot?.sources['sheet:nl']).toBe(3_700);
    expect(snapshot?.sources['trainings:2026']).toBe(1_700);
    expect(snapshot?.sources['rows:total']).toBe(snapshot?.rows.length);
  });

  it('uses the Amsterdam date for the completion rule', async () => {
    // 02:45Z in August is 04:45 in Amsterdam — the same day, and after local midnight.
    const report = await runNightly(deps(), { bootstrap: true });

    expect(report.today).toBe('2026-08-12');
  });

  describe('a dry run', () => {
    it('reports everything and writes nothing', async () => {
      const d = deps();

      const report = await runNightly(d, { dryRun: true, bootstrap: true });

      expect(report.dryRun).toBe(true);
      expect(report.written).toBe(false);
      expect(report.rows).toBeGreaterThan(0);
      expect(await d.store.read()).toBeNull();
    });

    /** A dry run must never move the baseline — that is what makes it safe to schedule. */
    it('leaves an existing record untouched', async () => {
      const d = deps();
      await runNightly(d, { bootstrap: true });
      const before = await d.store.read();

      await runNightly(d, { dryRun: true });

      expect(await d.store.read()).toEqual(before);
    });
  });

  describe('refusals', () => {
    it('refuses when the sources collapse below the absolute floor', async () => {
      const d = deps({}, build({ responses: 10, trainings: 1_700, qualPairs: 1_500 }));

      const report = await runNightly(d, { bootstrap: true });

      expect(report).toMatchObject({ written: false, refused: 'source_floor' });
      expect(report.detail).toContain(String(MIN_RESPONSES));
      expect(await d.store.read()).toBeNull();
    });

    it('refuses when the desired row set collapses', async () => {
      const d = deps({}, build({ responses: 3_700, trainings: 20, qualPairs: 5 }));

      const report = await runNightly(d, { bootstrap: true });

      expect(report).toMatchObject({ written: false, refused: 'row_floor' });
    });

    /**
     * The case the per-document counts exist for. Losing the English sheet is 235 of
     * 3.713 responses — invisible in the total, unmissable in `sheet:en`.
     */
    it('refuses when one document silently drops out', async () => {
      const d = deps();
      await d.store.write({
        rows: [],
        writtenAt: '2026-08-11T02:45:00.000Z',
        today: '2026-08-11',
        // Yesterday the NL sheet had far more; today's 3.700 is a >10% fall.
        sources: { 'sheet:nl': 5_000, 'responses:total': 5_000, 'rows:total': 2_000 },
      });

      const report = await runNightly(d);

      expect(report).toMatchObject({ written: false, refused: 'source_drop' });
      expect(report.detail).toContain('sheet:nl');
    });

    /** These counts only accumulate, so the default 50% factor would be far too loose. */
    it('tolerates a fall smaller than the drop factor', async () => {
      const d = deps();
      const barelyLower = Math.floor(3_700 / DROP_FACTOR) - 1;
      await d.store.write({
        rows: [],
        writtenAt: '2026-08-11T02:45:00.000Z',
        today: '2026-08-11',
        sources: { 'sheet:nl': barelyLower, 'responses:total': barelyLower },
      });

      expect((await runNightly(d)).written).toBe(true);
    });

    /**
     * A refused run leaves the previous record exactly as it was. Stale statistics are a
     * known, visible state; wrong ones are not.
     */
    it('leaves the previous record intact when it refuses', async () => {
      const d = deps();
      await runNightly(d, { bootstrap: true });
      const before = await d.store.read();

      const collapsed = deps({ store: d.store }, build({ responses: 5, trainings: 3, qualPairs: 1 }));
      const report = await runNightly({ ...collapsed, store: d.store });

      expect(report.written).toBe(false);
      expect(await d.store.read()).toEqual(before);
    });

    /**
     * Without a baseline the drop guard cannot run, so a first run missing an entire
     * smaller source clears the global floors, publishes, and becomes the baseline every
     * later night is measured against. The collapse is then permanent and invisible.
     */
    it('refuses to publish a first record on its own', async () => {
      const d = deps();

      const report = await runNightly(d);

      expect(report).toMatchObject({ written: false, refused: 'no_baseline' });
      expect(await d.store.read()).toBeNull();
    });

    /**
     * `force` is for a floor or drop someone inspected. Letting it cover `no_baseline`
     * would make `?force=1` on the cron URL an undocumented bootstrap — publishing a
     * first record that no guard and no human ever checked.
     */
    it('force does NOT create the first record', async () => {
      const d = deps();

      const report = await runNightly(d, { force: true });

      expect(report).toMatchObject({ written: false, refused: 'no_baseline' });
      expect(await d.store.read()).toBeNull();
    });

    it('bootstraps only when asked deliberately', async () => {
      const d = deps();

      expect((await runNightly(d, { bootstrap: true })).written).toBe(true);
    });

    /**
     * `checkSourceDrop` walks the PREVIOUS keys and skips any whose current value is not
     * a number — so removing `sheet:en` from the document list deletes the key and evades
     * the per-document guard entirely, while the ~6% dent in the total stays under any
     * global threshold.
     */
    it('treats a source key that disappeared as zero', async () => {
      const d = deps();
      await d.store.write({
        rows: [],
        writtenAt: '2026-08-11T02:45:00.000Z',
        today: '2026-08-11',
        sources: { 'sheet:nl': 3_700, 'sheet:en': 235, 'responses:total': 3_935 },
      });

      // This run's fixture has only `sheet:nl`; `sheet:en` is simply gone.
      const report = await runNightly(d);

      expect(report).toMatchObject({ written: false, refused: 'source_drop' });
      expect(report.detail).toContain('sheet:en');
    });

    it('writes anyway under force, and says what it overrode', async () => {
      const d = deps({}, build({ responses: 10, trainings: 1_700, qualPairs: 1_500 }));

      const report = await runNightly(d, { force: true, bootstrap: true });

      expect(report.written).toBe(true);
      expect(report.refused).toBeNull();
      expect(report.detail).toMatch(/forced past/);
    });

    it('force in a dry run still writes nothing', async () => {
      const d = deps({}, build({ responses: 10, trainings: 1_700, qualPairs: 1_500 }));

      const report = await runNightly(d, { dryRun: true, force: true, bootstrap: true });

      expect(report.written).toBe(false);
      expect(report.detail).toMatch(/would have refused/);
      expect(await d.store.read()).toBeNull();
    });
  });

  describe('a failing source is never a small one', () => {
    /**
     * Each read throws on its own failure rather than returning a partial result,
     * because the guards cannot tell a partial view from a real change.
     */
    it('propagates a sheets failure instead of writing fewer rows', async () => {
      const d = deps({
        source: { readResponses: () => Promise.reject(new Error('Sheets 403')) },
      });

      await expect(runNightly(d)).rejects.toThrow(/403/);
      expect(await d.store.read()).toBeNull();
    });

    it('propagates an Agenda failure', async () => {
      const d = deps({ readHistory: () => Promise.reject(new Error('below the floor')) });

      await expect(runNightly(d)).rejects.toThrow(/below the floor/);
    });

    it('propagates a qualifications failure', async () => {
      const d = deps({ readQualifications: () => Promise.reject(new Error('schema drift')) });

      await expect(runNightly(d)).rejects.toThrow(/drift/);
    });
  });

  it('reports how old the previous record was', async () => {
    const d = deps();
    await d.store.write({
      rows: [],
      writtenAt: '2026-08-11T02:45:00.000Z',
      today: '2026-08-11',
      sources: {},
    });

    expect((await runNightly(d)).previousAgeHours).toBe(24);
  });
});
