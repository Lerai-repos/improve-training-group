import { describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '../kv';
import { createOutcomeStore } from '../outcome';

const ITEM = '5029726254';

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
  });

  it('records an outcome and reads it back', async () => {
    const store = createOutcomeStore(createMemoryKvStore());
    expect(await store.claim(ITEM, 1, 'GEREED')).toBe('GEREED');
    expect(await store.read(ITEM, 1)).toBe('GEREED');
  });

  it('the first writer wins — a second compute cannot overwrite the label', async () => {
    const store = createOutcomeStore(createMemoryKvStore());
    await store.claim(ITEM, 1, 'GEREED');

    // A duplicate execution finished second with a different answer (the roster or a
    // route changed mid-flight). It must be told the winning label, not its own.
    expect(await store.claim(ITEM, 1, 'GEEN MATCH')).toBe('GEREED');
    expect(await store.read(ITEM, 1)).toBe('GEREED');
  });

  it('scopes outcomes per generation and per training', async () => {
    const store = createOutcomeStore(createMemoryKvStore());
    await store.claim(ITEM, 1, 'GEREED');
    await store.claim(ITEM, 2, 'FOUT');
    await store.claim('other', 1, 'GEEN MATCH');

    expect(await store.read(ITEM, 1)).toBe('GEREED');
    expect(await store.read(ITEM, 2)).toBe('FOUT');
    expect(await store.read('other', 1)).toBe('GEEN MATCH');
  });

  /**
   * No expiry. QStash's fixed-plan DLQ retention runs to three calendar months and
   * enterprise retention is custom, so any fixed TTL could lapse before a replay and
   * let that replay recompute a different answer for a generation already delivered.
   */
  it('stores outcomes without an expiry', async () => {
    const kv = createMemoryKvStore();
    const store = createOutcomeStore(kv);
    await store.claim(ITEM, 7, 'GEREED');
    expect(await kv.ttl(`result:${ITEM}:7`)).toEqual({ kind: 'no-expiry' });
  });

  it('ignores a stored value that is not a terminal label', async () => {
    const kv = createMemoryKvStore();
    const store = createOutcomeStore(kv);
    await kv.set(`result:${ITEM}:1`, 'RUN');
    expect(await store.read(ITEM, 1)).toBeNull();
  });
});
