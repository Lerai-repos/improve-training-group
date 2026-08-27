import { describe, expect, it } from 'vitest';

import { createRecordingStatusWriter } from '../delivery';
import { createMemoryKvStore } from '../kv';
import { createQueueStore, type QueueStore } from '../queue-store';
import { deliverOutcome, MAX_REPAIR_HOPS } from '../deliver';
import type { JobPublisher, PublishedJob } from '../queue';

const ITEM = '5029726254';

function publisher(): JobPublisher & { published: PublishedJob[] } {
  const published: PublishedJob[] = [];
  return {
    published,
    publish(job) {
      published.push(job);
      return Promise.resolve();
    },
  };
}

/** Drive the per-training counter to `n` without going through the queue. */
async function generationAt(store: QueueStore, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await store.enqueueOrGet({ triggerUuid: `u${i}`, mondayItemId: ITEM, nowMs: 0 });
  }
}

function harness() {
  const store = createQueueStore(createMemoryKvStore());
  return { store, writer: createRecordingStatusWriter(), pub: publisher() };
}

describe('deliverOutcome', () => {
  it('writes exactly once when the generation is still current', async () => {
    const { store, writer, pub } = harness();
    await generationAt(store, 1);

    const result = await deliverOutcome(
      { queue: store, writer, publisher: pub },
      { mondayItemId: ITEM, generation: 1, label: 'GEREED' }
    );

    expect(result).toEqual({ delivered: true, repairPublished: false });
    expect(writer.writes).toEqual([{ itemId: ITEM, label: 'GEREED', idempotencyKey: `${ITEM}:1` }]);
    expect(pub.published).toEqual([]);
  });

  /**
   * The cheap early-out the Postgres design lacked: it only discovered supersession
   * AFTER computing, at `apply_recommendations`. Detecting it before the write costs
   * one GET and keeps a stale label off the board entirely.
   */
  it('does not write at all when a newer generation already exists', async () => {
    const { store, writer, pub } = harness();
    await generationAt(store, 3);

    const result = await deliverOutcome(
      { queue: store, writer, publisher: pub },
      { mondayItemId: ITEM, generation: 1, label: 'GEREED' }
    );

    expect(result).toEqual({ delivered: false, reason: 'superseded' });
    expect(writer.writes).toEqual([]);
    expect(pub.published).toEqual([]);
  });

  /**
   * The residual race the design accepts: a newer generation can be allocated after
   * the pre-write check and before the write lands. Convergence — not exclusion — is
   * what fixes it, so the post-write recheck must publish a repair.
   */
  it('publishes a repair when a newer generation appears mid-write', async () => {
    const { store, pub } = harness();
    await generationAt(store, 1);

    const racingWriter = createRecordingStatusWriter();
    const deps = {
      queue: store,
      publisher: pub,
      newRepairId: () => 'r1',
      writer: {
        async writeStatus(
          itemId: string,
          label: 'GEREED' | 'GEEN MATCH' | 'FOUT',
          opts?: { idempotencyKey?: string }
        ) {
          // A second trigger lands while our mutation is in flight.
          await store.enqueueOrGet({ triggerUuid: 'racer', mondayItemId: ITEM, nowMs: 0 });
          await racingWriter.writeStatus(itemId, label, opts);
        },
      },
    };

    const result = await deliverOutcome(deps, {
      mondayItemId: ITEM,
      generation: 1,
      label: 'GEREED',
    });

    expect(result).toEqual({ delivered: true, repairPublished: true });
    expect(racingWriter.writes).toHaveLength(1);
    expect(pub.published).toEqual([
      { triggerUuid: `repair:${ITEM}:2:r1`, mondayItemId: ITEM, generation: 2, hop: 1 },
    ]);
  });

  /**
   * The case this exists for is precisely the one where nothing else can help: the
   * newer generation FINISHED while our write was stalled, so our stale label is now on
   * top of the correct one and that newer job is already gone. Dropping the repair
   * would leave the board wrong indefinitely, so it has to become durable work.
   */
  it('hands a failed repair publish to the sweep instead of dropping it', async () => {
    const { store } = harness();
    await generationAt(store, 1);
    const writer = createRecordingStatusWriter();

    const deps = {
      queue: store,
      nowMs: () => 42,
      newRepairId: () => 'r1',
      publisher: { publish: () => Promise.reject(new Error('QStash unavailable')) },
      writer: {
        async writeStatus(
          itemId: string,
          label: 'GEREED' | 'GEEN MATCH' | 'FOUT',
          opts?: { idempotencyKey?: string }
        ) {
          await store.enqueueOrGet({ triggerUuid: 'racer', mondayItemId: ITEM, nowMs: 0 });
          await writer.writeStatus(itemId, label, opts);
        },
      },
    };

    const result = await deliverOutcome(deps, {
      mondayItemId: ITEM,
      generation: 1,
      label: 'GEREED',
    });

    // The write landed, so this is still a success — but the repair is now durable.
    expect(result).toEqual({ delivered: true, repairPublished: false });
    expect(await store.readTrigger(`repair:${ITEM}:2:r1`)).toMatchObject({
      mondayItemId: ITEM,
      generation: 2,
      status: 'pending',
    });
    expect(await store.dueTriggers(42, 10)).toContain(`repair:${ITEM}:2:r1`);
  });

  /**
   * The repair id must identify THIS stale write, not the generation it targets. Two
   * concurrent executions of one generation can each land a stale write; keyed on the
   * target alone, the second repair would be deduplicated away — by QStash on publish,
   * or by `recordJob` finding the first record still present — and the board would stay
   * wrong with nothing left to fix it.
   */
  it('gives each detected stale write its own repair id', async () => {
    const { store, pub } = harness();
    await generationAt(store, 1);
    const writer = createRecordingStatusWriter();
    let attempt = 0;
    let bumped = false;

    const deps = {
      queue: store,
      publisher: pub,
      newRepairId: () => `attempt-${(attempt += 1)}`,
      writer: {
        async writeStatus(
          itemId: string,
          label: 'GEREED' | 'GEEN MATCH' | 'FOUT',
          opts?: { idempotencyKey?: string }
        ) {
          // ONE newer trigger arrives, so both in-flight executions see the same
          // `after` — which is exactly when a target-keyed id would collide.
          if (!bumped) {
            bumped = true;
            await store.enqueueOrGet({ triggerUuid: 'racer', mondayItemId: ITEM, nowMs: 0 });
          }
          await writer.writeStatus(itemId, label, opts);
        },
      },
    };
    const input = { mondayItemId: ITEM, generation: 1, label: 'GEREED' as const };

    // Concurrent, not sequential: both must clear the pre-write check before the bump,
    // which is the only way two stale writes land for one generation.
    await Promise.all([deliverOutcome(deps, input), deliverOutcome(deps, input)]);

    const ids = pub.published.map((j) => j.triggerUuid);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2); // distinct → neither repair is deduplicated away
    expect(ids.every((id) => id.startsWith(`repair:${ITEM}:2:`))).toBe(true);
  });

  it('stops repairing at the hop cap so a chain cannot run away', async () => {
    const { store, writer, pub } = harness();
    await generationAt(store, 1);

    const deps = {
      queue: store,
      publisher: pub,
      writer: {
        async writeStatus(
          itemId: string,
          label: 'GEREED' | 'GEEN MATCH' | 'FOUT',
          opts?: { idempotencyKey?: string }
        ) {
          await store.enqueueOrGet({ triggerUuid: 'racer', mondayItemId: ITEM, nowMs: 0 });
          await writer.writeStatus(itemId, label, opts);
        },
      },
    };

    const result = await deliverOutcome(deps, {
      mondayItemId: ITEM,
      generation: 1,
      label: 'GEREED',
      hop: MAX_REPAIR_HOPS,
    });

    expect(result).toEqual({ delivered: true, repairPublished: false });
    expect(writer.writes).toHaveLength(1);
    expect(pub.published).toEqual([]);
  });

  it('carries the label through unchanged — delivery never re-decides it', async () => {
    const { store, writer, pub } = harness();
    await generationAt(store, 1);

    await deliverOutcome(
      { queue: store, writer, publisher: pub },
      { mondayItemId: ITEM, generation: 1, label: 'FOUT' }
    );

    expect(writer.writes[0].label).toBe('FOUT');
  });
});
