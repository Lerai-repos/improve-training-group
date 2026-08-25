import { describe, expect, it } from 'vitest';

import { createApproachedStore } from '../approached';
import { createMemoryKvStore } from '../kv';
import { createOutcomeStore } from '../outcome';
import { createQueueStore } from '../queue-store';
import { createRunQueue } from '../queue';
import {
  handleApproached,
  handleRecalculate,
  type ApproachedDeps,
  type RecalculateDeps,
} from '../recommendation-actions';
import { storedRow } from './stored-row.fixture';
import type { ItemBoardReader } from '../item-board';
import type { JobPublisher } from '../queue';

const ITEM = '5029726254';
const AGENDA = '5087396949';
const ACTION = 'a1b2c3d4e5f6';

const boardsSaying = (boardId: string | null): ItemBoardReader => ({
  readBoardId: () => Promise.resolve(boardId),
});

function harness(boardId: string | null = AGENDA) {
  const kv = createMemoryKvStore();
  const store = createQueueStore(kv);
  const outcomes = createOutcomeStore(kv);
  const approached = createApproachedStore(kv);
  const published: string[] = [];
  const publisher: JobPublisher = {
    publish: (job) => {
      published.push(`${job.mondayItemId}:${job.generation}`);
      return Promise.resolve();
    },
  };

  const recalculate: RecalculateDeps = {
    queue: createRunQueue(store, publisher),
    boards: boardsSaying(boardId),
    agendaBoardId: AGENDA,
  };
  const approachedDeps: ApproachedDeps = {
    queue: store,
    outcomes,
    approached,
    boards: boardsSaying(boardId),
    agendaBoardId: AGENDA,
  };

  return { kv, store, outcomes, approached, published, recalculate, approachedDeps };
}

describe('handleRecalculate', () => {
  it('queues a generation and reports it', async () => {
    const h = harness();

    const result = await handleRecalculate(h.recalculate, {
      mondayItemId: ITEM,
      body: { actionId: ACTION },
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, data: { queued: true, generation: 1 } });
    expect(h.published).toEqual([`${ITEM}:1`]);
  });

  /**
   * The client keeps one `actionId` while retrying, so a flaky network cannot buy two
   * computations. The second call is a SUCCESS, not a conflict — the button should
   * settle rather than show an error for work that is already queued.
   */
  it('treats a repeated actionId as already queued, not as an error', async () => {
    const h = harness();
    const body = { actionId: ACTION };

    await handleRecalculate(h.recalculate, { mondayItemId: ITEM, body });
    const second = await handleRecalculate(h.recalculate, { mondayItemId: ITEM, body });

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ success: true, data: { queued: false, reason: 'duplicate' } });
    expect(h.published).toEqual([`${ITEM}:1`]);
    expect(await h.store.readGeneration(ITEM)).toBe(1);
  });

  it('a deliberate second press allocates the next generation', async () => {
    const h = harness();

    await handleRecalculate(h.recalculate, { mondayItemId: ITEM, body: { actionId: ACTION } });
    await handleRecalculate(h.recalculate, { mondayItemId: ITEM, body: { actionId: 'f6e5d4c3b2a1' } });

    expect(await h.store.readGeneration(ITEM)).toBe(2);
  });

  /**
   * `GET` is account-wide by design; spending provider money is not. Without this, any
   * item id in the account would be a lever on our Routes and Monday budget.
   */
  it('refuses an item that is not on the Agenda board', async () => {
    const h = harness('9999999');

    const result = await handleRecalculate(h.recalculate, {
      mondayItemId: ITEM,
      body: { actionId: ACTION },
    });

    expect(result).toEqual({ status: 403, body: { success: false, error: 'forbidden' } });
    expect(h.published).toEqual([]);
  });

  it('refuses an item that does not exist, without saying which it was', async () => {
    const h = harness(null);

    const result = await handleRecalculate(h.recalculate, {
      mondayItemId: ITEM,
      body: { actionId: ACTION },
    });

    // Same answer as "another board": an authenticated caller gets no oracle for which
    // ids exist.
    expect(result).toEqual({ status: 403, body: { success: false, error: 'forbidden' } });
  });

  /**
   * The actionId becomes a Redis key component. A value containing `:` could be shaped
   * to collide with another record's key, so the charset is constrained rather than
   * trusted.
   */
  it('rejects an actionId that could be shaped into another key', async () => {
    const h = harness();

    for (const actionId of ['short', `x:${ITEM}:1`, 'a'.repeat(65), '', 'has spaces']) {
      const result = await handleRecalculate(h.recalculate, { mondayItemId: ITEM, body: { actionId } });
      expect(result.status).toBe(400);
    }
    expect(h.published).toEqual([]);
  });

  it('rejects a body that is not the expected shape', async () => {
    const h = harness();

    for (const body of [null, {}, { actionId: 42 }, 'nope']) {
      expect((await handleRecalculate(h.recalculate, { mondayItemId: ITEM, body })).status).toBe(400);
    }
  });

  /** The board is checked BEFORE the queue, so a refused call costs nothing. */
  it('checks the board before allocating anything', async () => {
    const h = harness('9999999');

    await handleRecalculate(h.recalculate, { mondayItemId: ITEM, body: { actionId: ACTION } });

    expect(await h.store.readGeneration(ITEM)).toBe(0);
  });
});

describe('handleApproached', () => {
  async function ready(h: ReturnType<typeof harness>, trainerIds: string[] = ['t1', 't2']) {
    await h.store.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    await h.outcomes.claim(ITEM, 1, {
      kind: 'ready',
      settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      trainingMonth: null, duurTraining: null, travelPrecision: null,
      rows: trainerIds.map((trainerItemId, index) => storedRow({ trainerItemId, rank: index + 1 })),
    });
  }

  // A real Monday item id — the schema requires digits, so a placeholder like `t1`
  // would be a 400 and would mask whatever the test was actually about.
  const body = (overrides: Record<string, unknown> = {}) => ({
    generation: 1,
    trainerItemId: '1001',
    approached: true,
    ...overrides,
  });

  it('marks a trainer on the current list', async () => {
    const h = harness();
    await ready(h, ['1001', '1002']);

    const result = await handleApproached(h.approachedDeps, {
      mondayItemId: ITEM,
      body: body({ trainerItemId: '1001' }),
    });

    expect(result.status).toBe(200);
    expect(await h.approached.read(ITEM, 1, ['1001', '1002'])).toEqual(new Set(['1001']));
  });

  it('unmarks one', async () => {
    const h = harness();
    await ready(h, ['1001']);
    await handleApproached(h.approachedDeps, {
      mondayItemId: ITEM,
      body: body({ trainerItemId: '1001' }),
    });

    await handleApproached(h.approachedDeps, {
      mondayItemId: ITEM,
      body: body({ trainerItemId: '1001', approached: false }),
    });

    expect(await h.approached.read(ITEM, 1, ['1001'])).toEqual(new Set());
  });

  /**
   * Another planner may have recalculated since the view loaded. Applying the tick to
   * whatever list is current would attach it to a trainer nobody is looking at.
   */
  it('refuses a stale generation with 409, naming the current one', async () => {
    const h = harness();
    await ready(h, ['1001']);
    await h.store.enqueueOrGet({ triggerUuid: 'u2', mondayItemId: ITEM, nowMs: 0 });

    const result = await handleApproached(h.approachedDeps, {
      mondayItemId: ITEM,
      body: body({ trainerItemId: '1001' }),
    });

    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).toContain('generation 2');
  });

  /**
   * A mark that is not on the list would be invisible — it is only ever read back per
   * listed trainer — so it would look like a success that did nothing.
   */
  it('refuses a trainer who is not on this list with 422', async () => {
    const h = harness();
    await ready(h, ['1001']);

    const result = await handleApproached(h.approachedDeps, {
      mondayItemId: ITEM,
      body: body({ trainerItemId: '9999' }),
    });

    expect(result.status).toBe(422);
    expect(await h.approached.read(ITEM, 1, ['9999'])).toEqual(new Set());
  });

  it('refuses when there is no ranked list to annotate', async () => {
    const h = harness();
    await h.store.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });
    await h.outcomes.claim(ITEM, 1, { kind: 'no_match', settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' } });

    const result = await handleApproached(h.approachedDeps, {
      mondayItemId: ITEM,
      body: body({ trainerItemId: '1001' }),
    });

    expect(result.status).toBe(409);
  });

  it('refuses while the list is still computing', async () => {
    const h = harness();
    await h.store.enqueueOrGet({ triggerUuid: 'u1', mondayItemId: ITEM, nowMs: 0 });

    expect(
      (await handleApproached(h.approachedDeps, { mondayItemId: ITEM, body: body() })).status
    ).toBe(409);
  });

  it('refuses an item that is not on the Agenda board', async () => {
    const h = harness('9999999');
    await ready(h, ['1001']);

    const result = await handleApproached(h.approachedDeps, {
      mondayItemId: ITEM,
      body: body({ trainerItemId: '1001' }),
    });

    expect(result).toEqual({ status: 403, body: { success: false, error: 'forbidden' } });
  });

  it('rejects a malformed body', async () => {
    const h = harness();
    await ready(h, ['1001']);

    const bodies = [
      body({ generation: 0 }),
      body({ generation: 'one' }),
      body({ trainerItemId: 'not-an-id' }),
      body({ approached: 'yes' }),
      {},
      null,
    ];

    for (const invalid of bodies) {
      expect(
        (await handleApproached(h.approachedDeps, { mondayItemId: ITEM, body: invalid })).status
      ).toBe(400);
    }
  });

  /**
   * The check and the write are not atomic either. A recalculate landing between them
   * puts the mark on a generation nobody will read again — and answering 200 would be
   * the worst outcome available: the planner sees the tick accepted, the next `GET`
   * reads the new generation's marks, and it has simply vanished. They would reasonably
   * conclude the feature loses data.
   */
  it('refuses when the list moves between the check and the write', async () => {
    const h = harness();
    await ready(h, ['1001']);

    // Current on the way in, advanced by the time the mark is stored.
    let reads = 0;
    const queue = {
      readGeneration: () => {
        reads += 1;
        return Promise.resolve(reads === 1 ? 1 : 2);
      },
    };

    const result = await handleApproached(
      { ...h.approachedDeps, queue },
      { mondayItemId: ITEM, body: body({ trainerItemId: '1001' }) }
    );

    expect(result.status).toBe(409);
    expect(JSON.stringify(result.body)).toContain('generation 2');
  });

  /**
   * One key per trainer, so two planners ticking two different trainers at the same
   * moment cannot lose one another's write.
   */
  it('lets concurrent marks for different trainers both survive', async () => {
    const h = harness();
    await ready(h, ['1001', '1002']);

    await Promise.all([
      handleApproached(h.approachedDeps, {
        mondayItemId: ITEM,
        body: body({ trainerItemId: '1001' }),
      }),
      handleApproached(h.approachedDeps, {
        mondayItemId: ITEM,
        body: body({ trainerItemId: '1002' }),
      }),
    ]);

    expect(await h.approached.read(ITEM, 1, ['1001', '1002'])).toEqual(new Set(['1001', '1002']));
  });
});
