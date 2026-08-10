import { describe, expect, it } from 'vitest';

import { createRecordingStatusWriter } from '../delivery';
import { createMemoryKvStore } from '../kv';
import { createOutcomeStore } from '../outcome';
import { createQueueStore, type QueueStore } from '../queue-store';
import { runJob, type JobDeps } from '../job';
import { storedRow } from './stored-row.fixture';
import type { InputArtifact } from '../artifact';
import type { RecommendationResult } from '../service';
import type { JobPublisher, PublishedJob } from '../queue';

const ITEM = '5029726254';

// The artifact is provenance; `runJob` never reads it, so a minimal valid one keeps
// these tests about the retryability contract rather than about artifact shape.
const artifact: InputArtifact = {
  version: 3,
  code: { gitSha: null, calcVersion: 'test' },
  training: { externalItemId: ITEM, datum: '2026-09-01', duurTraining: 8, themeExternalIds: [] },
  qualifications: { observations: [], effective: [], ackVersion: null },
  scores: [],
  trainers: [],
  rates: {
    inputSyncRunId: null,
    rateCards: [],
    travelTimeConfig: { thresholdMinutes: 0, mode: 'per_minute', feePerMinuteCents: 0 },
    trainerTravelRateCentsPerKm: 0,
    clientTravelRateCentsPerKm: 0,
  },
  enrichment: {
    addressDecisionKind: 'travel_required',
    addressReason: null,
    model: null,
    promptVersion: null,
    routingProfile: 'test',
    routes: [],
  },
};

const ok = (status: 'GEREED' | 'GEEN MATCH'): RecommendationResult => ({
  ok: true,
  resultStatus: status,
  recommendations: [],
  // Mirrors `service.ts`: GEREED means at least one trainer was ranked, GEEN MATCH means
  // none were. A fixture pairing GEREED with an empty list would be a state the engine
  // cannot produce, and the outcome store now refuses it.
  rows: status === 'GEREED' ? [storedRow()] : [],
  artifact,
  artifactHash: 'h',
  counts: { candidate: 1, eligible: 1, recommended: status === 'GEREED' ? 1 : 0 },
  excluded: [],
  addressDecision: null,
  providerErrors: null,
  mondayItemRevision: 'rev-1',
  travelCacheHits: 0,
});

const failed = (retryable: boolean): RecommendationResult => ({
  ok: false,
  resultStatus: 'FOUT',
  failure: { stage: 'travel', message: 'boom', retryable },
  partial: {},
});

function harness(result: RecommendationResult | (() => Promise<RecommendationResult>)) {
  const kv = createMemoryKvStore();
  const store = createQueueStore(kv);
  const writer = createRecordingStatusWriter();
  const published: PublishedJob[] = [];
  const publisher: JobPublisher = {
    publish(job) {
      published.push(job);
      return Promise.resolve();
    },
  };
  let computes = 0;
  const deps: JobDeps = {
    store,
    outcomes: createOutcomeStore(kv),
    publisher,
    writer,
    runRecommendation: () => {
      computes += 1;
      return typeof result === 'function' ? result() : Promise.resolve(result);
    },
  };
  return { deps, store, writer, published, computes: () => computes };
}

async function generationAt(store: QueueStore, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await store.enqueueOrGet({ triggerUuid: `u${i}`, mondayItemId: ITEM, nowMs: 0 });
  }
}

const job = { triggerUuid: 'u0', mondayItemId: ITEM, generation: 1 };

describe('runJob', () => {
  it('writes GEREED and reports success', async () => {
    const h = harness(ok('GEREED'));
    await generationAt(h.store, 1);

    const outcome = await runJob(h.deps, job);

    expect(outcome).toEqual({ kind: 'delivered', label: 'GEREED', repairPublished: false });
    expect(h.writer.writes).toEqual([
      { itemId: ITEM, label: 'GEREED', idempotencyKey: `${ITEM}:1` },
    ]);
  });

  /**
   * The label and the rows are claimed together. If they could be written separately, a
   * crash in between would leave a delivered answer whose list was lost for good — the
   * early return on a stored label means this code never runs again to repair it.
   */
  it('records the rows alongside the label, and the watermark with them', async () => {
    const h = harness(ok('GEREED'));
    await generationAt(h.store, 1);

    await runJob(h.deps, job);

    expect(await h.deps.outcomes.read(ITEM, 1)).toBe('GEREED');
    expect(await h.deps.outcomes.readDetail(ITEM, 1)).toMatchObject({ kind: 'ready' });
    expect(await h.deps.outcomes.readCompletedGeneration(ITEM)).toBe(1);
  });

  it('records GEEN MATCH as an empty list, not as a missing one', async () => {
    const h = harness(ok('GEEN MATCH'));
    await generationAt(h.store, 1);

    await runJob(h.deps, job);

    // The view must show "niemand gevonden", never a spinner or an error.
    expect(await h.deps.outcomes.readDetail(ITEM, 1)).toMatchObject({
      kind: 'no_match',
      rows: [],
    });
  });

  it('records a terminal failure with its stage, and no rows', async () => {
    const h = harness(failed(false));
    await generationAt(h.store, 1);

    await runJob(h.deps, job);

    expect(await h.deps.outcomes.readDetail(ITEM, 1)).toMatchObject({
      kind: 'failed',
      rows: null,
    });
  });

  /**
   * A transient failure must leave the generation completely undecided — no label, no
   * rows, and no watermark. Otherwise the retry that follows would find a stored answer
   * and deliver it instead of computing one.
   */
  it('records nothing at all for a retryable failure', async () => {
    const h = harness(failed(true));
    await generationAt(h.store, 1);

    await runJob(h.deps, job);

    expect(await h.deps.outcomes.read(ITEM, 1)).toBeNull();
    expect(await h.deps.outcomes.readDetail(ITEM, 1)).toBeNull();
    expect(await h.deps.outcomes.readCompletedGeneration(ITEM)).toBe(0);
  });

  it('skips compute entirely when a newer generation exists', async () => {
    const h = harness(ok('GEREED'));
    await generationAt(h.store, 2);

    const outcome = await runJob(h.deps, job);

    expect(outcome).toEqual({ kind: 'superseded' });
    expect(h.computes()).toBe(0);
    expect(h.writer.writes).toEqual([]);
  });

  /**
   * The whole reason outcomes are immutable: a QStash retry must re-deliver the
   * label that was already decided, not run the engine again against live data that
   * may since have changed.
   */
  it('re-delivers a stored outcome without recomputing', async () => {
    const h = harness(ok('GEREED'));
    await generationAt(h.store, 1);
    await h.deps.outcomes.claim(ITEM, 1, { kind: 'no_match' });

    const outcome = await runJob(h.deps, job);

    expect(outcome).toEqual({ kind: 'delivered', label: 'GEEN MATCH', repairPublished: false });
    expect(h.computes()).toBe(0);
    expect(h.writer.writes[0].label).toBe('GEEN MATCH');
  });

  it('a terminal failure writes FOUT once and tells the queue to stop', async () => {
    const h = harness(failed(false));
    await generationAt(h.store, 1);

    const outcome = await runJob(h.deps, job);

    expect(outcome).toMatchObject({ kind: 'terminal', label: 'FOUT' });
    expect(h.writer.writes).toEqual([{ itemId: ITEM, label: 'FOUT', idempotencyKey: `${ITEM}:1` }]);
    expect(await h.deps.outcomes.read(ITEM, 1)).toBe('FOUT');
  });

  /**
   * A transient failure must NOT commit a terminal outcome: doing so would freeze a
   * provider hiccup into the immutable record, and every later retry would faithfully
   * re-deliver that FOUT instead of the answer the training deserves.
   */
  it('a transient failure records NOTHING and asks for a retry', async () => {
    const h = harness(failed(true));
    await generationAt(h.store, 1);

    const outcome = await runJob(h.deps, job);

    expect(outcome).toMatchObject({ kind: 'retry', stage: 'travel' });
    expect(h.writer.writes).toEqual([]);
    expect(await h.deps.outcomes.read(ITEM, 1)).toBeNull();
  });

  it('asks for a retry when the Monday write fails, keeping the computed outcome', async () => {
    const h = harness(ok('GEREED'));
    await generationAt(h.store, 1);
    h.deps.writer = {
      writeStatus: () => Promise.reject(new Error('monday 503')),
    };

    const outcome = await runJob(h.deps, job);

    expect(outcome).toMatchObject({ kind: 'retry' });
    // The answer survives, so the retry delivers it rather than recomputing.
    expect(await h.deps.outcomes.read(ITEM, 1)).toBe('GEREED');
  });

  /**
   * Losing the claim race means we deliver the WINNER's answer. Reporting our own
   * failure then would dead-letter a message whose Monday write succeeded and fire a
   * false alert, so the recorded outcome has to decide, not this execution's result.
   */
  it('reports success when it loses the claim race to a GEREED winner', async () => {
    const kv = createMemoryKvStore();
    const store = createQueueStore(kv);
    const outcomes = createOutcomeStore(kv);
    const writer = createRecordingStatusWriter();
    await generationAt(store, 1);

    const deps: JobDeps = {
      store,
      outcomes,
      publisher: { publish: () => Promise.resolve() },
      writer,
      runRecommendation: async () => {
        // The race has to happen DURING compute: `runJob` reads the stored outcome
        // before computing, so pre-seeding it would short-circuit and prove nothing.
        await outcomes.claim(ITEM, 1, { kind: 'ready', rows: [storedRow()] });
        return failed(false); // ours failed terminally, but it lost the claim
      },
    };

    const outcome = await runJob(deps, job);

    expect(outcome).toMatchObject({ kind: 'delivered', label: 'GEREED' });
    expect(writer.writes[0].label).toBe('GEREED');
  });

  /**
   * A repair is best-effort convergence and the Monday write has already landed, so a
   * QStash outage must not turn a successful delivery into a retry — that would rewrite
   * the board and eventually dead-letter a job that did its work.
   */
  it('still reports delivered when the repair publish fails', async () => {
    const h = harness(ok('GEREED'));
    await generationAt(h.store, 1);
    h.deps.publisher = { publish: () => Promise.reject(new Error('QStash unavailable')) };
    const inner = h.deps.writer;
    h.deps.writer = {
      async writeStatus(itemId, label, opts) {
        await h.store.enqueueOrGet({ triggerUuid: 'racer', mondayItemId: ITEM, nowMs: 0 });
        await inner.writeStatus(itemId, label, opts);
      },
    };

    const outcome = await runJob(h.deps, job);

    expect(outcome).toEqual({ kind: 'delivered', label: 'GEREED', repairPublished: false });
    expect(h.writer.writes).toHaveLength(1);
  });

  it('publishes a repair when a newer generation lands mid-write', async () => {
    const h = harness(ok('GEREED'));
    await generationAt(h.store, 1);
    const inner = h.deps.writer;
    h.deps.writer = {
      async writeStatus(itemId, label, opts) {
        await h.store.enqueueOrGet({ triggerUuid: 'racer', mondayItemId: ITEM, nowMs: 0 });
        await inner.writeStatus(itemId, label, opts);
      },
    };

    const outcome = await runJob(h.deps, job);

    expect(outcome).toMatchObject({ kind: 'delivered', repairPublished: true });
    expect(h.published).toHaveLength(1);
    // The id carries a per-attempt suffix, so match its shape rather than a literal.
    expect(h.published[0]).toMatchObject({ mondayItemId: ITEM, generation: 2, hop: 1 });
    expect(h.published[0].triggerUuid).toMatch(new RegExp(`^repair:${ITEM}:2:.+`));
  });
});
