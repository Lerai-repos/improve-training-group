import { describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '../kv';
import { createQueueStore, FIRST_SWEEP_DELAY_MS, type QueueStore } from '../queue-store';
import {
  ALERT_AFTER_ATTEMPTS,
  LONG_RETRY_INTERVAL_MS,
  sweepPending,
  type JobPublisher,
  type PublishedJob,
} from '../queue';

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

const failing: JobPublisher = {
  publish: () => Promise.reject(new Error('QStash unavailable')),
};

/** A trigger stuck pending, as a failed publish leaves it. */
async function stuck(store: QueueStore, uuid = 'u1'): Promise<void> {
  await store.enqueueOrGet({ triggerUuid: uuid, mondayItemId: ITEM, nowMs: 0 });
}

describe('sweepPending', () => {
  it('leaves an entry that is not yet due alone', async () => {
    const store = createQueueStore(createMemoryKvStore());
    await stuck(store);
    const pub = publisher();

    const result = await sweepPending({
      store,
      publisher: pub,
      nowMs: () => FIRST_SWEEP_DELAY_MS - 1,
    });

    expect(result.republished).toBe(0);
    expect(pub.published).toEqual([]);
  });

  it('republishes a due entry with its original generation and publishes it', async () => {
    const store = createQueueStore(createMemoryKvStore());
    await stuck(store);
    const pub = publisher();

    const result = await sweepPending({ store, publisher: pub, nowMs: () => FIRST_SWEEP_DELAY_MS });

    expect(result.republished).toBe(1);
    expect(pub.published).toEqual([{ triggerUuid: 'u1', mondayItemId: ITEM, generation: 1 }]);
    expect((await store.readTrigger('u1'))?.status).toBe('published');
    expect(await store.dueTriggers(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });

  /**
   * The recovery path for a repair whose publish failed. If the sweep dropped the
   * depth, the republished job would start a fresh chain at hop 0 and MAX_REPAIR_HOPS
   * would never bite.
   */
  it('republishes a recovered repair at its original depth', async () => {
    const store = createQueueStore(createMemoryKvStore());
    await store.recordJob({
      triggerUuid: 'repair:1',
      mondayItemId: ITEM,
      generation: 4,
      nowMs: 0,
      hop: 2,
    });
    const pub = publisher();

    await sweepPending({ store, publisher: pub, nowMs: () => 1 });

    expect(pub.published).toEqual([
      { triggerUuid: 'repair:1', mondayItemId: ITEM, generation: 4, hop: 2 },
    ]);
  });

  it('removes an orphan whose record is gone', async () => {
    let now = 0;
    const kv = createMemoryKvStore(() => now);
    const store = createQueueStore(kv);
    await stuck(store);

    // The record expires out from under its index entry (only reachable if someone
    // hand-edits Redis, but the sweep must not spin on it forever either way).
    const raw = await kv.get('trigger:u1');
    await kv.set('trigger:u1', raw ?? '', { ttlMs: 1 });
    now = FIRST_SWEEP_DELAY_MS;

    const pub = publisher();
    const result = await sweepPending({ store, publisher: pub, nowMs: () => now });

    expect(result.orphansRemoved).toBe(1);
    expect(pub.published).toEqual([]);
    expect(await store.dueTriggers(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });

  it('removes an index entry whose record is already published', async () => {
    const kv = createMemoryKvStore();
    const store = createQueueStore(kv);
    await stuck(store);

    // A crash between markPublished's SET and its ZREM leaves exactly this state.
    const raw = await kv.get('trigger:u1');
    await kv.set('trigger:u1', (raw ?? '').replace('"pending"', '"published"'));

    const pub = publisher();
    const result = await sweepPending({
      store,
      publisher: pub,
      nowMs: () => FIRST_SWEEP_DELAY_MS,
    });

    expect(result.orphansRemoved).toBe(1);
    expect(pub.published).toEqual([]);
    expect(await store.dueTriggers(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });

  it('reschedules with backoff when publication fails again', async () => {
    const store = createQueueStore(createMemoryKvStore());
    await stuck(store);

    const now = FIRST_SWEEP_DELAY_MS;
    const result = await sweepPending({ store, publisher: failing, nowMs: () => now });

    expect(result.republished).toBe(0);
    expect(result.failed).toBe(1);
    expect((await store.readTrigger('u1'))?.attempts).toBe(1);
    // Rescheduled into the future, so the next sweep does not spin on it.
    expect(await store.dueTriggers(now, 10)).toEqual([]);
  });

  /**
   * An attempt CAP would make a long QStash outage unrecoverable: the highest
   * generation stays pending, blocks every older generation from writing, and needs a
   * human. Alerting is the escalation; retrying is the recovery.
   */
  it('keeps retrying past the alert threshold instead of parking the record', async () => {
    const store = createQueueStore(createMemoryKvStore());
    await stuck(store);

    let now = FIRST_SWEEP_DELAY_MS;
    for (let i = 0; i < ALERT_AFTER_ATTEMPTS + 3; i += 1) {
      await sweepPending({ store, publisher: failing, nowMs: () => now });
      now += LONG_RETRY_INTERVAL_MS;
    }

    const record = await store.readTrigger('u1');
    expect(record?.status).toBe('pending');
    expect(record?.attempts).toBe(ALERT_AFTER_ATTEMPTS + 3);

    // Still recoverable: once QStash is back, the very next sweep publishes it.
    const pub = publisher();
    const recovered = await sweepPending({ store, publisher: pub, nowMs: () => now });
    expect(recovered.republished).toBe(1);
    expect(pub.published).toEqual([{ triggerUuid: 'u1', mondayItemId: ITEM, generation: 1 }]);
  });

  it('reports that the alert threshold was crossed', async () => {
    const store = createQueueStore(createMemoryKvStore());
    await stuck(store);

    let now = FIRST_SWEEP_DELAY_MS;
    let alerted = 0;
    for (let i = 0; i < ALERT_AFTER_ATTEMPTS + 1; i += 1) {
      alerted += (await sweepPending({ store, publisher: failing, nowMs: () => now })).alerted;
      now += LONG_RETRY_INTERVAL_MS;
    }
    expect(alerted).toBeGreaterThan(0);
  });
});
