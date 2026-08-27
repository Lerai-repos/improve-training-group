import { describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '../kv';
import { createQueueStore, PUBLISHED_TTL_MS, type QueueStore } from '../queue-store';

const ITEM = '5029726254';

function store(now: () => number = () => 1_000): {
  queue: QueueStore;
  kv: ReturnType<typeof createMemoryKvStore>;
} {
  const kv = createMemoryKvStore(now);
  return { queue: createQueueStore(kv), kv };
}

describe('enqueueOrGet', () => {
  it('allocates a strictly increasing generation per training', async () => {
    const { queue } = store();
    const a = await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    const b = await queue.enqueueOrGet({ triggerUuid: 'u2', mondayItemId: ITEM, nowMs: 0 });
    expect(a.created).toBe(true);
    expect(a.record.generation).toBe(1);
    expect(b.record.generation).toBe(2);
  });

  it('scopes the generation per training, so unrelated trainings never interfere', async () => {
    const { queue } = store();
    const a = await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: 'A', nowMs: 0 });
    const b = await queue.enqueueOrGet({ triggerUuid: 'u2', mondayItemId: 'B', nowMs: 0 });
    expect(a.record.generation).toBe(1);
    expect(b.record.generation).toBe(1);
  });

  it('returns the SAME record for a repeated triggerUuid without burning a generation', async () => {
    const { queue } = store();
    const first = await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    const again = await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    expect(again.created).toBe(false);
    expect(again.record).toEqual(first.record);
    expect(await queue.readGeneration(ITEM)).toBe(1);
  });

  // The v3 fix: durability must not depend on anything running on a schedule.
  it('writes the pending record with NO expiry and indexes it', async () => {
    const { queue, kv } = store();
    await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    expect(await kv.ttl('trigger:u1')).toEqual({ kind: 'no-expiry' });
    expect(await queue.dueTriggers(Number.MAX_SAFE_INTEGER, 10)).toEqual(['u1']);
  });
});

describe('markPublished', () => {
  it('moves pending → published, applies the TTL and drops the index entry', async () => {
    const { queue, kv } = store();
    await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    expect(await queue.markPublished('u1')).toBe(true);

    const record = await queue.readTrigger('u1');
    expect(record?.status).toBe('published');
    expect(await kv.ttl('trigger:u1')).toEqual({ kind: 'expires', ms: PUBLISHED_TTL_MS });
    expect(await queue.dueTriggers(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });

  it('is idempotent — a second call reports no transition and preserves the record', async () => {
    const { queue } = store();
    await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    await queue.markPublished('u1');
    expect(await queue.markPublished('u1')).toBe(false);
    expect((await queue.readTrigger('u1'))?.status).toBe('published');
  });

  it('is a no-op for an unknown trigger', async () => {
    const { queue } = store();
    expect(await queue.markPublished('ghost')).toBe(false);
  });
});

describe('bumpAttempt', () => {
  it('increments attempts and reschedules while pending', async () => {
    const { queue } = store();
    await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    const bumped = await queue.bumpAttempt('u1', 5_000);
    expect(bumped?.attempts).toBe(1);
    expect(await queue.dueTriggers(4_999, 10)).toEqual([]);
    expect(await queue.dueTriggers(5_000, 10)).toEqual(['u1']);
  });

  /**
   * The v4 race. The webhook publishes while the sweep is mid-flight; if the bump
   * were a read-modify-write in application code it would write back the stale
   * `pending` record — resurrecting a published trigger whose index entry the
   * webhook had already removed, leaving it stuck pending AND unindexed forever.
   */
  it('never resurrects a published record', async () => {
    const { queue } = store();
    await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    await queue.markPublished('u1');

    expect(await queue.bumpAttempt('u1', 9_999)).toBeNull();
    expect((await queue.readTrigger('u1'))?.status).toBe('published');
    expect(await queue.dueTriggers(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });

  it('returns null for an unknown trigger', async () => {
    const { queue } = store();
    expect(await queue.bumpAttempt('ghost', 1)).toBeNull();
  });
});

describe('the pending index', () => {
  it('returns only due entries, oldest first, bounded by the limit', async () => {
    const { queue } = store();
    await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: 'A', nowMs: 0 });
    await queue.enqueueOrGet({ triggerUuid: 'u2', mondayItemId: 'B', nowMs: 1_000 });
    await queue.enqueueOrGet({ triggerUuid: 'u3', mondayItemId: 'C', nowMs: 2_000 });

    const due = await queue.dueTriggers(Number.MAX_SAFE_INTEGER, 2);
    expect(due).toEqual(['u1', 'u2']);
  });

  it('removePending drops an orphan whose record is gone', async () => {
    const { queue } = store();
    await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    await queue.removePending('u1');
    expect(await queue.dueTriggers(Number.MAX_SAFE_INTEGER, 10)).toEqual([]);
  });
});

/**
 * Why production MUST use `createUpstashQueueStore` (the Lua one).
 *
 * `createQueueStore` does its transitions as read-modify-write in TypeScript. That is
 * fine sequentially, and broken the moment two deliveries of the same trigger overlap
 * — which is exactly what Monday's retry storm produces. Production was once wired to
 * this adapter by mistake; the test below is the damage that caused, kept so the next
 * person who reaches for it can see the cost.
 */
describe('createQueueStore is NOT safe for concurrent callers', () => {
  it('burns TWO generations for one trigger when two callers overlap', async () => {
    const queue = createQueueStore(createMemoryKvStore());
    const input = { triggerUuid: 'same-uuid', mondayItemId: ITEM, nowMs: 0 };

    // Concurrent, not sequential: both suspend on the initial read before either
    // writes, so both conclude the trigger is new.
    const [a, b] = await Promise.all([queue.enqueueOrGet(input), queue.enqueueOrGet(input)]);

    expect([a.record.generation, b.record.generation]).toEqual([1, 2]);
    expect(await queue.readGeneration(ITEM)).toBe(2);

    // The damage: QStash deduplicates on triggerUuid, so only ONE job is published.
    // If that is generation 1, its own `readGeneration` returns 2, it declares itself
    // superseded, and the training silently never gets an answer.
    expect(a.record.generation).toBeLessThan(await queue.readGeneration(ITEM));
  });
});

/**
 * A repair targets a generation that ALREADY exists, so unlike `enqueueOrGet` it must
 * allocate nothing. It becomes an ordinary pending record, which is what lets the sweep
 * publish it with no special handling.
 */
describe('recordJob', () => {
  it('records a pending job at the GIVEN generation without allocating one', async () => {
    const { queue } = store();
    await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    await queue.markPublished('u1');

    const created = await queue.recordJob({
      triggerUuid: 'repair:1',
      mondayItemId: ITEM,
      generation: 1,
      nowMs: 0,
    });

    expect(created).toBe(true);
    expect(await queue.readGeneration(ITEM)).toBe(1); // counter untouched
    expect(await queue.readTrigger('repair:1')).toMatchObject({
      generation: 1,
      status: 'pending',
      attempts: 0,
    });
    expect(await queue.dueTriggers(0, 10)).toEqual(['repair:1']);
  });

  /**
   * A recovered repair must resume at its real depth. Without this the sweep would
   * republish it as a fresh hop 0, restarting the chain and defeating MAX_REPAIR_HOPS.
   */
  it('persists the repair depth', async () => {
    const { queue } = store();
    await queue.recordJob({
      triggerUuid: 'repair:1',
      mondayItemId: ITEM,
      generation: 1,
      nowMs: 0,
      hop: 2,
    });
    expect((await queue.readTrigger('repair:1'))?.hop).toBe(2);
  });

  it('leaves hop absent for a plain trigger', async () => {
    const { queue } = store();
    await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    expect((await queue.readTrigger('u1'))?.hop).toBeUndefined();
  });

  it('does not overwrite an existing record, so attempts are never reset', async () => {
    const { queue } = store();
    const input = { triggerUuid: 'repair:1', mondayItemId: ITEM, generation: 1, nowMs: 0 };
    await queue.recordJob(input);
    await queue.bumpAttempt('repair:1', 500);

    expect(await queue.recordJob(input)).toBe(false);
    expect((await queue.readTrigger('repair:1'))?.attempts).toBe(1);
  });
});

describe('readGeneration', () => {
  it('is 0 before any trigger and tracks the counter after', async () => {
    const { queue } = store();
    expect(await queue.readGeneration(ITEM)).toBe(0);
    await queue.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    expect(await queue.readGeneration(ITEM)).toBe(1);
  });
});
