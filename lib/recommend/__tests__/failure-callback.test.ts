import { describe, expect, it } from 'vitest';

import { createRecordingStatusWriter } from '../delivery';
import { createMemoryKvStore } from '../kv';
import { createOutcomeStore } from '../outcome';
import { createQueueStore, type QueueStore } from '../queue-store';
import { handleFailureCallback, type FailureCallbackDeps } from '../failure-callback';
import { storedRow } from './stored-row.fixture';
import type { JobPublisher } from '../queue';

const ITEM = '5029726254';

const publisher: JobPublisher = { publish: () => Promise.resolve() };

function harness() {
  const kv = createMemoryKvStore();
  const store = createQueueStore(kv);
  const writer = createRecordingStatusWriter();
  const deps: FailureCallbackDeps = {
    store,
    outcomes: createOutcomeStore(kv),
    alerts: createOutcomeAlertGate(kv),
    publisher,
    writer,
  };
  return { deps, store, writer, kv };
}

// Local mirror of the production gate so the test does not reach into deps.ts.
function createOutcomeAlertGate(kv: ReturnType<typeof createMemoryKvStore>) {
  return { shouldAlert: (dlqId: string) => kv.setIfAbsent(`alert:${dlqId}`, '1') };
}

async function generationAt(store: QueueStore, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await store.enqueueOrGet({ triggerUuid: `u${i}`, mondayItemId: ITEM, nowMs: 0 });
  }
}

const callback = { mondayItemId: ITEM, generation: 1, dlqId: 'dlq-1' };

describe('handleFailureCallback', () => {
  /**
   * The one that matters most. A job can compute GEREED and then fail only at the
   * Monday write; if the callback wrote FOUT it would replace a perfectly good answer
   * with an error, and contradict the immutable outcome for that generation.
   */
  it('re-delivers a stored GEREED rather than replacing it with FOUT', async () => {
    const h = harness();
    await generationAt(h.store, 1);
    await h.deps.outcomes.claim(ITEM, 1, { kind: 'ready', duurTraining: null, rows: [storedRow()], trainingMonth: null, settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' } });

    const result = await handleFailureCallback(h.deps, callback);

    expect(result).toMatchObject({ kind: 'delivered', label: 'GEREED' });
    expect(h.writer.writes).toEqual([
      { itemId: ITEM, label: 'GEREED', idempotencyKey: `${ITEM}:1` },
    ]);
    expect(await h.deps.outcomes.read(ITEM, 1)).toBe('GEREED');
  });

  it('records and delivers FOUT when compute never produced an outcome', async () => {
    const h = harness();
    await generationAt(h.store, 1);

    const result = await handleFailureCallback(h.deps, callback);

    expect(result).toMatchObject({ kind: 'delivered', label: 'FOUT' });
    expect(h.writer.writes[0].label).toBe('FOUT');
    // Immutable from here: a DLQ replay cannot now compute a different answer.
    expect(await h.deps.outcomes.read(ITEM, 1)).toBe('FOUT');
    // There is no compute stage to name — compute never finished. `dlq_exhausted` says
    // exactly that, and keeps it distinguishable from a failure the engine diagnosed.
    expect(await h.deps.outcomes.readDetail(ITEM, 1)).toMatchObject({
      kind: 'failed',
      /**
       * NULL, and that is the point.
       *
       * Compute never finished, so there is no settings snapshot to name — and the
       * settings read may be precisely what failed. This is why `failed` permits null
       * provenance at v2: requiring it would make this FOUT unrecordable and leave the
       * board spinning on `computing` for ever, for exactly the failure the design
       * exists to surface.
       */
      settings: null,
      rows: null,
      failure: { stage: 'dlq_exhausted' },
    });
  });

  /**
   * The delivery-only case, verified live on 2026-08-06: compute stored GEREED, the
   * Monday write failed against a bogus column, and the callback re-delivered GEREED
   * rather than stamping FOUT. Its rows must survive that path untouched too — they are
   * what the planner is about to look at.
   */
  it('keeps a stored run’s rows when it re-delivers instead of failing', async () => {
    const h = harness();
    await generationAt(h.store, 1);
    await h.deps.outcomes.claim(ITEM, 1, {
      kind: 'ready',
      settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      duurTraining: null,
      rows: [storedRow({ trainerItemId: 't1', rank: 1 })],
      trainingMonth: null,
    });

    await handleFailureCallback(h.deps, callback);

    expect(await h.deps.outcomes.readDetail(ITEM, 1)).toMatchObject({
      kind: 'ready',
      settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      duurTraining: null,
      rows: [{ trainerItemId: 't1', rank: 1 }],
    });
  });

  it('no-ops when a newer generation already exists', async () => {
    const h = harness();
    await generationAt(h.store, 3);

    const result = await handleFailureCallback(h.deps, callback);

    expect(result).toEqual({ kind: 'superseded', alerted: false });
    expect(h.writer.writes).toEqual([]);
    expect(await h.deps.outcomes.read(ITEM, 1)).toBeNull();
  });

  it('alerts once per dlqId, because the callback itself can be redelivered', async () => {
    const h = harness();
    await generationAt(h.store, 1);

    const first = await handleFailureCallback(h.deps, callback);
    const second = await handleFailureCallback(h.deps, callback);

    expect(first.alerted).toBe(true);
    expect(second.alerted).toBe(false);
  });

  /**
   * Reports `undeliverable` so the route can answer non-2xx and have QStash redeliver
   * the callback. Swallowing this as success would end convergence at exactly the
   * moment Monday is unavailable — the situation the callback exists for — leaving the
   * previous generation's label on the board indefinitely.
   */
  it('reports undeliverable when the Monday write fails, keeping the outcome', async () => {
    const h = harness();
    await generationAt(h.store, 1);
    h.deps.writer = { writeStatus: () => Promise.reject(new Error('monday 503')) };

    const result = await handleFailureCallback(h.deps, callback);

    expect(result).toMatchObject({ kind: 'undeliverable', label: 'FOUT' });
    // Recorded, so the redelivered callback re-sends the same label rather than
    // deciding a new one.
    expect(await h.deps.outcomes.read(ITEM, 1)).toBe('FOUT');
  });

  it('is idempotent on redelivery — the label is written again, never changed', async () => {
    const h = harness();
    await generationAt(h.store, 1);

    await handleFailureCallback(h.deps, callback);
    await handleFailureCallback(h.deps, callback);

    expect(h.writer.writes.map((w) => w.label)).toEqual(['FOUT', 'FOUT']);
    expect(await h.deps.outcomes.read(ITEM, 1)).toBe('FOUT');
  });
});
