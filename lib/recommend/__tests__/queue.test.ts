import { beforeEach, describe, expect, it } from 'vitest';

import { createMemoryKvStore, type KvStore } from '../kv';
import { createQueueStore, PUBLISHED_TTL_MS, type QueueStore } from '../queue-store';
import { createRunQueue, type JobPublisher, type PublishedJob } from '../queue';

const ITEM = '5029726254';

function recordingPublisher(): JobPublisher & { published: PublishedJob[] } {
  const published: PublishedJob[] = [];
  return {
    published,
    publish(job) {
      published.push(job);
      return Promise.resolve();
    },
  };
}

function harness(): { queue: ReturnType<typeof createRunQueue>; store: QueueStore; kv: KvStore; publisher: ReturnType<typeof recordingPublisher> } {
  const kv = createMemoryKvStore(() => 1_000);
  const store = createQueueStore(kv);
  const publisher = recordingPublisher();
  return { queue: createRunQueue(store, publisher, () => 1_000), store, kv, publisher };
}

const trigger = { triggerUuid: 'u1', triggerKind: 'manual_button' as const, mondayItemId: ITEM };

describe('enqueue', () => {
  it('allocates a generation and publishes one job', async () => {
    const { queue, publisher } = harness();
    const result = await queue.enqueue(trigger);

    expect(result).toEqual({ accepted: true, generation: 1 });
    expect(publisher.published).toEqual([
      { triggerUuid: 'u1', mondayItemId: ITEM, generation: 1 },
    ]);
  });

  it('marks the record published, applying the dedup TTL only then', async () => {
    const { queue, store, kv } = harness();
    await queue.enqueue(trigger);

    expect((await store.readTrigger('u1'))?.status).toBe('published');
    expect(await kv.ttl('trigger:u1')).toEqual({ kind: 'expires', ms: PUBLISHED_TTL_MS });
    expect(await store.dueTriggers(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });

  it('reports a duplicate for a trigger already published, without republishing', async () => {
    const { queue, publisher } = harness();
    await queue.enqueue(trigger);
    const again = await queue.enqueue(trigger);

    expect(again).toEqual({ accepted: false, reason: 'duplicate' });
    expect(publisher.published).toHaveLength(1);
  });

  /**
   * THE regression this whole design exists for. An earlier version wrote a dedup
   * marker BEFORE the job was durably queued: when publication failed, Monday's retry
   * found the marker, returned "duplicate", and the trigger was lost forever.
   *
   * The record must survive a failed publish, stay pending, stay indexed, and keep
   * its generation — so the retry resumes publication rather than swallowing it.
   */
  describe('when publication fails', () => {
    let failing: JobPublisher & { calls: number };

    beforeEach(() => {
      failing = {
        calls: 0,
        publish() {
          failing.calls += 1;
          return Promise.reject(new Error('QStash unavailable'));
        },
      };
    });

    it('propagates the error so the route returns non-2xx and Monday retries', async () => {
      const kv = createMemoryKvStore(() => 1_000);
      const queue = createRunQueue(createQueueStore(kv), failing, () => 1_000);
      await expect(queue.enqueue(trigger)).rejects.toThrow('QStash unavailable');
    });

    it('leaves a durable, indexed, still-pending record', async () => {
      const kv = createMemoryKvStore(() => 1_000);
      const store = createQueueStore(kv);
      const queue = createRunQueue(store, failing, () => 1_000);
      await expect(queue.enqueue(trigger)).rejects.toThrow();

      const record = await store.readTrigger('u1');
      expect(record?.status).toBe('pending');
      expect(await kv.ttl('trigger:u1')).toEqual({ kind: 'no-expiry' });
      expect(await store.dueTriggers(Number.MAX_SAFE_INTEGER, 10)).toEqual(['u1']);
    });

    it('resumes publication on the retry, reusing the ORIGINAL generation', async () => {
      const kv = createMemoryKvStore(() => 1_000);
      const store = createQueueStore(kv);
      const working = recordingPublisher();

      await expect(createRunQueue(store, failing, () => 1_000).enqueue(trigger)).rejects.toThrow();
      const retry = await createRunQueue(store, working, () => 1_000).enqueue(trigger);

      expect(retry).toEqual({ accepted: true, generation: 1 });
      expect(working.published).toEqual([
        { triggerUuid: 'u1', mondayItemId: ITEM, generation: 1 },
      ]);
      // No second generation was burnt by the failed attempt.
      expect(await store.readGeneration(ITEM)).toBe(1);
    });
  });
});

describe('generation allocation across triggers', () => {
  it('gives each distinct trigger for one training the next generation', async () => {
    const { queue } = harness();
    const first = await queue.enqueue(trigger);
    const second = await queue.enqueue({ ...trigger, triggerUuid: 'u2' });

    expect(first).toEqual({ accepted: true, generation: 1 });
    expect(second).toEqual({ accepted: true, generation: 2 });
  });
});
