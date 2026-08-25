import { describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '../kv';
import { createOutcomeStore, ROWS_TTL_MS, type OutcomeClaim } from '../outcome';
import { storedRow } from './stored-row.fixture';

const ITEM = '5029726254';

const READY: OutcomeClaim = { kind: 'ready', duurTraining: null, travelPrecision: null, rows: [storedRow()], trainingMonth: null, settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' } };
const NO_MATCH: OutcomeClaim = { kind: 'no_match', settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' } };
const FAILED: OutcomeClaim = { kind: 'failed', stage: 'travel', message: 'unreachable', settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' } };

/**
 * One immutable outcome per (training, generation). Without it, every QStash retry,
 * repair hop and DLQ replay recomputes from live Monday data and paid providers, so
 * two deliveries at the same generation could produce DIFFERENT labels and the last
 * writer would win nondeterministically. Postgres never had that problem — its
 * redelivery path re-wrote the stored `result_status`.
 */
describe('createOutcomeStore', () => {
  it('is empty before anything is computed', async () => {
    const store = createOutcomeStore(createMemoryKvStore());
    expect(await store.read(ITEM, 1)).toBeNull();
    expect(await store.readDetail(ITEM, 1)).toBeNull();
    expect(await store.readCompletedGeneration(ITEM)).toBe(0);
  });

  /**
   * A property of the TRAINING, stored once for the whole list. The view shows it above
   * the table beside "Duur facturatie"; a value that did not survive the round trip would
   * leave the header silently blank on every training.
   */
  it('carries the training’s duration back out of the store', async () => {
    const store = createOutcomeStore(createMemoryKvStore());
    await store.claim(ITEM, 1, { ...READY, duurTraining: 3.5 });

    expect(await store.readDetail(ITEM, 1)).toMatchObject({ duurTraining: 3.5 });
  });

  /** The board's `duur` column can be empty; null must stay null, never become 0. */
  it('keeps an unknown duration null', async () => {
    const store = createOutcomeStore(createMemoryKvStore());
    await store.claim(ITEM, 1, READY);

    expect(await store.readDetail(ITEM, 1)).toMatchObject({ duurTraining: null });
  });

  it('records an outcome and reads back both the label and its rows', async () => {
    const store = createOutcomeStore(createMemoryKvStore());
    expect(await store.claim(ITEM, 1, READY)).toBe('GEREED');
    expect(await store.read(ITEM, 1)).toBe('GEREED');
    expect(await store.readDetail(ITEM, 1)).toMatchObject({ kind: 'ready' });
  });

  it('the first writer wins — a second compute cannot overwrite the label', async () => {
    const store = createOutcomeStore(createMemoryKvStore());
    await store.claim(ITEM, 1, READY);

    // A duplicate execution finished second with a different answer (the roster or a
    // route changed mid-flight). It must be told the winning label, not its own.
    expect(await store.claim(ITEM, 1, NO_MATCH)).toBe('GEREED');
    expect(await store.read(ITEM, 1)).toBe('GEREED');
    // …and the winner's rows must survive too, or the board and the list would disagree.
    expect(await store.readDetail(ITEM, 1)).toMatchObject({ kind: 'ready' });
  });

  it('scopes outcomes per generation and per training', async () => {
    const store = createOutcomeStore(createMemoryKvStore());
    await store.claim(ITEM, 1, READY);
    await store.claim(ITEM, 2, FAILED);
    await store.claim('other', 1, NO_MATCH);

    expect(await store.read(ITEM, 1)).toBe('GEREED');
    expect(await store.read(ITEM, 2)).toBe('FOUT');
    expect(await store.read('other', 1)).toBe('GEEN MATCH');
  });

  /**
   * No expiry on the LABEL. The pending sweep retries a stuck trigger indefinitely
   * (`docs/m2b/README.md` §3), so the replay horizon is unbounded — a TTL could lapse
   * before a replay and let it recompute a generation already delivered.
   */
  it('stores the label without an expiry, and the rows with one', async () => {
    // Frozen clock: `ttl()` reports the remaining time, so a real one makes the
    // expected value drift by however long the claim took.
    const kv = createMemoryKvStore(() => 1_000);
    const store = createOutcomeStore(kv);
    await store.claim(ITEM, 7, READY);

    expect(await kv.ttl(`result:${ITEM}:7`)).toEqual({ kind: 'no-expiry' });
    expect(await kv.ttl(`rows:${ITEM}:7`)).toEqual({ kind: 'expires', ms: ROWS_TTL_MS });
  });

  it('ignores a stored value that is not a terminal label', async () => {
    const kv = createMemoryKvStore();
    const store = createOutcomeStore(kv);
    await kv.set(`result:${ITEM}:1`, 'RUN');
    expect(await store.read(ITEM, 1)).toBeNull();
  });

  it('distinguishes GEEN MATCH (empty list) from FOUT (no list at all)', async () => {
    const store = createOutcomeStore(createMemoryKvStore());
    await store.claim(ITEM, 1, NO_MATCH);
    await store.claim(ITEM, 2, FAILED);

    // "We looked and found nobody" is an answer; the view must not show it as missing.
    expect(await store.readDetail(ITEM, 1)).toMatchObject({ kind: 'no_match', rows: [] });
    expect(await store.readDetail(ITEM, 2)).toMatchObject({
      kind: 'failed',
      settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' },
      rows: null,
      failure: { stage: 'travel', message: 'unreachable' },
    });
  });

  describe('the completed-generation watermark', () => {
    /**
     * Once the rows expire, "generation exists, no rows" is indistinguishable from
     * "still computing" — a year-old training would spin forever. The watermark is what
     * separates the two, so it must outlive the data it describes.
     */
    it('records the highest generation that produced a label', async () => {
      const store = createOutcomeStore(createMemoryKvStore());
      await store.claim(ITEM, 1, READY);
      expect(await store.readCompletedGeneration(ITEM)).toBe(1);

      await store.claim(ITEM, 3, READY);
      expect(await store.readCompletedGeneration(ITEM)).toBe(3);
    });

    it('never moves backwards when an older generation lands late', async () => {
      const store = createOutcomeStore(createMemoryKvStore());
      await store.claim(ITEM, 5, READY);
      await store.claim(ITEM, 2, READY);
      expect(await store.readCompletedGeneration(ITEM)).toBe(5);
    });

    it('is not raised by a claim that lost the race', async () => {
      const store = createOutcomeStore(createMemoryKvStore());
      await store.claim(ITEM, 4, READY);
      await store.claim(ITEM, 4, NO_MATCH);
      expect(await store.readCompletedGeneration(ITEM)).toBe(4);
    });

    it('survives the rows expiring, so the state stays honest', async () => {
      let now = 1_000;
      const kv = createMemoryKvStore(() => now);
      const store = createOutcomeStore(kv);
      await store.claim(ITEM, 1, READY);

      now += ROWS_TTL_MS + 1;

      expect(await store.readDetail(ITEM, 1)).toBeNull();
      expect(await store.read(ITEM, 1)).toBe('GEREED');
      // watermark >= generation ⇒ the caller reports `unavailable`, not `computing`.
      expect(await store.readCompletedGeneration(ITEM)).toBe(1);
    });
  });

  /**
   * Records written before the rows key existed are bare label strings under the SAME
   * key. Every delivery path must keep working against them untouched; they simply have
   * no detail, which the API reports as `unavailable`.
   */
  it('reads a legacy bare label, with no rows', async () => {
    const kv = createMemoryKvStore();
    const store = createOutcomeStore(kv);
    await kv.set(`result:${ITEM}:1`, 'GEREED');

    expect(await store.read(ITEM, 1)).toBe('GEREED');
    expect(await store.readDetail(ITEM, 1)).toBeNull();
    // A legacy claim is still refused — the label is already there.
    expect(await store.claim(ITEM, 1, NO_MATCH)).toBe('GEREED');
  });

  it('treats unparseable rows as absent rather than rendering nonsense', async () => {
    const kv = createMemoryKvStore();
    const store = createOutcomeStore(kv);
    await store.claim(ITEM, 1, READY);
    await kv.set(`rows:${ITEM}:1`, '{not json');

    expect(await store.readDetail(ITEM, 1)).toBeNull();
    expect(await store.read(ITEM, 1)).toBe('GEREED');
  });

  /**
   * The rows survive a round trip through Redis, so what comes back is `unknown`. A
   * schema that accepts any object would let a truncated or half-migrated record reach
   * the planner as a table of `undefined` — money in particular must be a number, never
   * the string a careless writer would produce.
   */
  describe('validating what comes back out', () => {
    async function detailFor(stored: unknown): Promise<unknown> {
      const kv = createMemoryKvStore();
      const store = createOutcomeStore(kv);
      await store.claim(ITEM, 1, READY);
      await kv.set(`rows:${ITEM}:1`, JSON.stringify(stored));
      return await store.readDetail(ITEM, 1);
    }

    const ready = (rows: unknown[]): unknown => ({ v: 1, kind: 'ready', rows, failure: null });

    it('accepts a well-formed row', async () => {
      expect(await detailFor(ready([storedRow()]))).toMatchObject({ kind: 'ready' });
    });

    it('rejects a row that is missing fields', async () => {
      expect(await detailFor(ready([{ trainerItemId: 't1', rank: 1 }]))).toBeNull();
    });

    it('rejects money that arrived as a string', async () => {
      expect(await detailFor(ready([{ ...storedRow(), totalCostCents: '35100' }]))).toBeNull();
    });

    it('rejects a qualification outside the known set', async () => {
      // Written as a loose literal on purpose: the typed fixture cannot express this,
      // and a value like `orange` is exactly what a hand-edited key would contain.
      const themes = [{ ...storedRow().themes[0], qualification: 'orange' }];
      expect(await detailFor(ready([{ ...storedRow(), themes }]))).toBeNull();
    });

    /**
     * The combination is the thing a flat schema cannot express. `ready` with no rows
     * would render an empty list as a successful answer, and `failed` carrying rows
     * would show a list the engine never stood behind.
     */
    it('rejects kinds paired with the wrong payload', async () => {
      expect(await detailFor({ v: 1, kind: 'ready', rows: null, failure: null })).toBeNull();
      expect(
        await detailFor({ v: 1, kind: 'failed', rows: [storedRow()], failure: null })
      ).toBeNull();
      expect(
        await detailFor({ v: 1, kind: 'no_match', rows: [storedRow()], failure: null })
      ).toBeNull();
    });
  });

  /**
   * The label is permanent and `runJob` short-circuits on it, so writing one beside an
   * invalid detail is not a bad record that a later attempt repairs — the next retry
   * sees the label, skips compute, and the rows are gone for good while the board reads
   * GEREED. The write is therefore validated by the same schema as the read, and it runs
   * before the first key is touched.
   */
  describe('refusing to claim an invalid outcome', () => {
    async function keysAfter(claim: OutcomeClaim): Promise<string[]> {
      const kv = createMemoryKvStore();
      const store = createOutcomeStore(kv);

      await expect(store.claim(ITEM, 1, claim)).rejects.toThrow(/invalid outcome/i);

      const present: string[] = [];
      for (const key of [`result:${ITEM}:1`, `rows:${ITEM}:1`, `completed-gen:${ITEM}`]) {
        if ((await kv.get(key)) !== null) {
          present.push(key);
        }
      }
      return present;
    }

    it('leaves all three keys absent when the rows are malformed', async () => {
      expect(await keysAfter({ kind: 'ready', duurTraining: null, travelPrecision: null, rows: [storedRow({ totalCostCents: NaN })], trainingMonth: null, settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' } })).toEqual(
        []
      );
    });

    it('leaves all three keys absent when a failure has no stage', async () => {
      expect(await keysAfter({ kind: 'failed', stage: '', message: 'boom', settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' } })).toEqual([]);
    });

    /**
     * `service.ts` emits GEREED exactly when `ranked.length > 0`. A ready claim with no
     * rows would store an artifact contradicting the very label it is stored beside.
     */
    it('leaves all three keys absent for a ready claim with no rows', async () => {
      expect(await keysAfter({ kind: 'ready', duurTraining: null, travelPrecision: null, rows: [], trainingMonth: null, settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' } })).toEqual([]);
    });

    it('does not disturb an outcome already claimed for another generation', async () => {
      const store = createOutcomeStore(createMemoryKvStore());
      await store.claim(ITEM, 1, READY);

      await expect(store.claim(ITEM, 2, { kind: 'ready', duurTraining: null, travelPrecision: null, rows: [], trainingMonth: null, settings: { boardId: 'settings-board', readAt: 0, fingerprint: 'test' } })).rejects.toThrow();

      expect(await store.read(ITEM, 1)).toBe('GEREED');
      expect(await store.readCompletedGeneration(ITEM)).toBe(1);
    });
  });

  /**
   * A corrupt watermark is not a number to fall back from. `Number('abc')` is `NaN`,
   * which is neither `< generation` nor `>= generation`, so the state resolver would
   * silently pick whichever branch came last. Defaulting to 0 is no better: it claims a
   * training that HAS completed never did, which is the permanent spinner the watermark
   * exists to prevent. Both adapters therefore refuse to guess.
   */
  it('refuses a malformed watermark instead of returning NaN or 0', async () => {
    const kv = createMemoryKvStore();
    const store = createOutcomeStore(kv);

    for (const corrupt of ['abc', '', '  ', '-1', '1.5', '9'.repeat(30)]) {
      await kv.set(`completed-gen:${ITEM}`, corrupt);
      await expect(store.readCompletedGeneration(ITEM)).rejects.toThrow(/watermark/i);
    }
  });

  /**
   * The bound is `Number.MAX_SAFE_INTEGER`, and it has to be the same bound in the Lua:
   * `tonumber('9'x30)` is `1e30`, which is integral and positive, so a sign-and-modulo
   * check accepts what this reader rejects. That disagreement would be unrecoverable —
   * `1e30` exceeds every real generation, so it is never overwritten, and every later
   * read of that training throws.
   */
  it('accepts the largest safe watermark, and nothing above it', async () => {
    const kv = createMemoryKvStore();
    const store = createOutcomeStore(kv);

    await kv.set(`completed-gen:${ITEM}`, String(Number.MAX_SAFE_INTEGER));
    expect(await store.readCompletedGeneration(ITEM)).toBe(Number.MAX_SAFE_INTEGER);

    await kv.set(`completed-gen:${ITEM}`, String(Number.MAX_SAFE_INTEGER + 2));
    await expect(store.readCompletedGeneration(ITEM)).rejects.toThrow(/watermark/i);
  });

  /**
   * Ordering, not just detection. Redis does not roll back the writes a script made
   * before it errored, so a watermark checked late would leave the permanent label and
   * the rows committed on top of a still-corrupt watermark — and the caller's retry
   * would find that label and skip compute. Checking first leaves nothing behind, which
   * is what makes the error safe to retry once the key is repaired.
   */
  it('writes nothing at all when the watermark is corrupt', async () => {
    const kv = createMemoryKvStore();
    const store = createOutcomeStore(kv);
    await kv.set(`completed-gen:${ITEM}`, 'abc');

    await expect(store.claim(ITEM, 1, READY)).rejects.toThrow(/watermark/i);

    expect(await kv.get(`result:${ITEM}:1`)).toBeNull();
    expect(await kv.get(`rows:${ITEM}:1`)).toBeNull();
  });

  /**
   * The in-memory store is single-threaded, which is NOT the same as atomic: the
   * watermark update is a read-modify-write across two awaits. Lua runs the whole claim
   * as one script and cannot interleave, so a twin that can would make every concurrency
   * test here assert behaviour production does not have.
   */
  it('keeps the watermark monotonic when claims run concurrently', async () => {
    const store = createOutcomeStore(createMemoryKvStore());

    await Promise.all([store.claim(ITEM, 5, READY), store.claim(ITEM, 2, READY)]);

    expect(await store.readCompletedGeneration(ITEM)).toBe(5);
  });

  it('resolves concurrent claims for different trainings independently', async () => {
    const store = createOutcomeStore(createMemoryKvStore());

    const labels = await Promise.all([
      store.claim(ITEM, 1, READY),
      store.claim('other', 1, NO_MATCH),
      store.claim(ITEM, 1, FAILED),
    ]);

    // Both trainings got their own first-writer outcome; the third lost its race.
    expect(labels[0]).toBe('GEREED');
    expect(labels[1]).toBe('GEEN MATCH');
    expect(labels[2]).toBe('GEREED');
  });
});

/**
 * `ROWS_TTL_MS` is a year, so every detail written before today is still being read.
 * Adding required fields to the stored shape would therefore have failed Zod on EVERY
 * existing recommendation the moment it deployed, and each one would have shown as
 * unavailable. Hence a version, not an extension.
 */
describe('stored outcome v1 → v2', () => {
  const rowsKey = `rows:${ITEM}:1`;

  const seedV1 = async (kv: ReturnType<typeof createMemoryKvStore>, detail: unknown) => {
    await kv.set(`result:${ITEM}:1`, 'GEREED');
    await kv.set(rowsKey, JSON.stringify(detail));
  };

  it('still decodes a v1 ready record, with null provenance', async () => {
    const kv = createMemoryKvStore();
    const store = createOutcomeStore(kv);
    await seedV1(kv, {
      v: 1,
      kind: 'ready',
      rows: [storedRow()],
      trainingMonth: null,
      duurTraining: null,
      failure: null,
    });

    expect(await store.readDetail(ITEM, 1)).toMatchObject({ kind: 'ready', settings: null });
  });

  it('still decodes a v1 no_match record', async () => {
    const kv = createMemoryKvStore();
    const store = createOutcomeStore(kv);
    await seedV1(kv, { v: 1, kind: 'no_match', rows: [], failure: null });

    expect(await store.readDetail(ITEM, 1)).toMatchObject({ kind: 'no_match', settings: null });
  });

  it('still decodes a v1 failed record', async () => {
    const kv = createMemoryKvStore();
    const store = createOutcomeStore(kv);
    await seedV1(kv, {
      v: 1,
      kind: 'failed',
      rows: null,
      failure: { stage: 'travel', message: 'unreachable' },
    });

    expect(await store.readDetail(ITEM, 1)).toMatchObject({ kind: 'failed', settings: null });
  });

  it('writes v2 and round-trips the provenance', async () => {
    const store = createOutcomeStore(createMemoryKvStore());
    const settings = { boardId: '99', readAt: 1_760_000_000_000, fingerprint: 'deadbeef' };
    await store.claim(ITEM, 1, { ...READY, settings });

    expect(await store.readDetail(ITEM, 1)).toMatchObject({ v: 2, settings });
  });

  /**
   * The case that would deadlock the design if provenance were required everywhere: a
   * settings read that never succeeded has no snapshot to name, and this is the claim
   * that has to be recordable anyway or the board never leaves `computing`.
   */
  it('accepts a v2 failed outcome with NO provenance', async () => {
    const store = createOutcomeStore(createMemoryKvStore());
    await store.claim(ITEM, 1, {
      kind: 'failed',
      stage: 'dlq_exhausted',
      message: null,
      settings: null,
    });

    expect(await store.readDetail(ITEM, 1)).toMatchObject({
      v: 2,
      kind: 'failed',
      settings: null,
    });
  });
});

/**
 * A version that does not change what is accepted is decoration. These pin the one
 * asymmetry that makes `v: 2` mean something.
 */
describe('v2 requires provenance where it can have it', () => {
  const seed = async (kv: ReturnType<typeof createMemoryKvStore>, detail: unknown) => {
    await kv.set(`result:${ITEM}:1`, 'GEREED');
    await kv.set(`rows:${ITEM}:1`, JSON.stringify(detail));
  };

  it('rejects a v2 ready record with no settings', async () => {
    const kv = createMemoryKvStore();
    await seed(kv, {
      v: 2,
      kind: 'ready',
      settings: null,
      rows: [storedRow()],
      trainingMonth: null,
      duurTraining: null,
      failure: null,
    });

    // Unreadable rather than silently indistinguishable from a v1 record.
    expect(await createOutcomeStore(kv).readDetail(ITEM, 1)).toBeNull();
  });

  it('rejects a v2 no_match record with no settings', async () => {
    const kv = createMemoryKvStore();
    await seed(kv, { v: 2, kind: 'no_match', settings: null, rows: [], failure: null });

    expect(await createOutcomeStore(kv).readDetail(ITEM, 1)).toBeNull();
  });

  it('still accepts the SAME shape at v1, which is what old records look like', async () => {
    const kv = createMemoryKvStore();
    await seed(kv, {
      v: 1,
      kind: 'no_match',
      settings: null,
      rows: [],
      failure: null,
    });

    expect(await createOutcomeStore(kv).readDetail(ITEM, 1)).toMatchObject({ kind: 'no_match' });
  });
});

/**
 * Only the failure that happens BEFORE compute may lack provenance. A failure inside a
 * run had a snapshot by definition, so omitting it there is a bug, not a fact.
 */
describe('null provenance is not a blanket excuse for failures', () => {
  const seed = async (kv: ReturnType<typeof createMemoryKvStore>, detail: unknown) => {
    await kv.set(`result:${ITEM}:1`, 'FOUT');
    await kv.set(`rows:${ITEM}:1`, JSON.stringify(detail));
  };

  const failedAt = (stage: string) => ({
    v: 2,
    kind: 'failed',
    settings: null,
    rows: null,
    failure: { stage, message: null },
  });

  it('accepts dlq_exhausted with no settings — compute never ran', async () => {
    const kv = createMemoryKvStore();
    await seed(kv, failedAt('dlq_exhausted'));

    expect(await createOutcomeStore(kv).readDetail(ITEM, 1)).toMatchObject({
      kind: 'failed',
      settings: null,
    });
  });

  it('rejects an in-run failure with no settings', async () => {
    for (const stage of ['travel', 'load_training', 'address']) {
      const kv = createMemoryKvStore();
      await seed(kv, failedAt(stage));

      expect(await createOutcomeStore(kv).readDetail(ITEM, 1)).toBeNull();
    }
  });

  it('accepts an in-run failure that DOES carry its settings', async () => {
    const kv = createMemoryKvStore();
    await seed(kv, {
      ...failedAt('travel'),
      settings: { boardId: '1', readAt: 0, fingerprint: 'f' },
    });

    expect(await createOutcomeStore(kv).readDetail(ITEM, 1)).toMatchObject({ kind: 'failed' });
  });
});
