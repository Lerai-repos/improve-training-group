import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api';
import { MAX_UNCERTAIN_ATTEMPTS, useWhatsappMessage } from '../use-whatsapp-message';

import type { WhatsappApi, WhatsappPayload, WhatsappWriteResult } from '../api';

/**
 * Nearly every test here is a partial failure, because that is where an autosaving text
 * box stops being a text box. The three rules under test:
 *
 *  1. the base travels with the text in the box, so a stale message stays flagged;
 *  2. one save in flight, the latest draft queued behind it;
 *  3. a discard reconciles first, and restores the last state the server acknowledged.
 */

const ITEM = '3141071021';
const GENERATED = 'Ben jij beschikbaar?\n\n23-03-2026\nRabobank';

interface Fake extends WhatsappApi {
  saves: Array<{ edited: string; base: string; token: string }>;
  /** Which training each save was addressed to — the per-item queue depends on it. */
  saveItems: string[];
  keepalives: boolean[];
  discards: string[];
  discardKeepalives: boolean[];
  gets: number;
}

function fakeApi(overrides: Partial<WhatsappApi> = {}, payload?: Partial<WhatsappPayload>): Fake {
  const saves: Fake['saves'] = [];
  const saveItems: string[] = [];
  const keepalives: boolean[] = [];
  const discards: string[] = [];
  const discardKeepalives: boolean[] = [];
  let gets = 0;

  const base: WhatsappApi = {
    getWhatsapp: () => {
      gets += 1;
      return Promise.resolve({
        generated: GENERATED,
        saved: null,
        token: 'absent',
        unreadable: false,
        warnings: [],
        ...payload,
      });
    },
    saveWhatsapp: (item, input, options) => {
      saves.push(input);
      saveItems.push(item);
      keepalives.push(options?.keepalive === true);
      return Promise.resolve<WhatsappWriteResult>({
        saved: { edited: input.edited, base: input.base },
        token: `tok-${saves.length}`,
      });
    },
    discardWhatsapp: (_item, token, options) => {
      discards.push(token);
      discardKeepalives.push(options?.keepalive === true);
      return Promise.resolve<WhatsappWriteResult>({ saved: null, token: 'tok-gone' });
    },
  };

  const api = { ...base, ...overrides };
  return {
    ...api,
    get saves() {
      return saves;
    },
    get saveItems() {
      return saveItems;
    },
    get keepalives() {
      return keepalives;
    },
    get discards() {
      return discards;
    },
    get discardKeepalives() {
      return discardKeepalives;
    },
    get gets() {
      return gets;
    },
  };
}

const open = (api: WhatsappApi, itemId: string | null = ITEM) =>
  renderHook(({ id }: { id: string | null }) => useWhatsappMessage(api, id, true), {
    initialProps: { id: itemId },
  });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1100);
  });
};

describe('loading', () => {
  it('shows the generated message when nothing is saved', async () => {
    const { result } = open(fakeApi());

    await waitFor(() => expect(result.current.text).toBe(GENERATED));
    expect(result.current.stale).toBe(false);
  });

  it('shows the saved edit instead, when there is one', async () => {
    const api = fakeApi({}, { saved: { edited: 'mijn tekst', base: GENERATED }, token: 'tok-0' });
    const { result } = open(api);

    await waitFor(() => expect(result.current.text).toBe('mijn tekst'));
  });

  it('reports a load failure rather than showing an empty box', async () => {
    const api = fakeApi({ getWhatsapp: () => Promise.reject(new Error('offline')) });
    const { result } = open(api);

    await waitFor(() => expect(result.current.loadError).toMatch(/offline/));
  });
});

describe('staleness', () => {
  it('flags an edit whose base no longer matches the generated message', async () => {
    const api = fakeApi({}, { saved: { edited: 'mijn tekst', base: 'OUDE TEKST' }, token: 't' });
    const { result } = open(api);

    await waitFor(() => expect(result.current.stale).toBe(true));
  });

  /**
   * Rule 1. Typing into a stale message must not quietly rebase it — the warning would
   * disappear while the old date sat in the text.
   */
  it('keeps sending the old base, so typing does not clear the warning', async () => {
    const api = fakeApi({}, { saved: { edited: 'mijn tekst', base: 'OUDE TEKST' }, token: 't' });
    const { result } = open(api);
    await waitFor(() => expect(result.current.stale).toBe(true));

    act(() => {
      result.current.setText('mijn tekst, aangevuld');
    });
    await settle();

    expect(api.saves[0]).toMatchObject({ base: 'OUDE TEKST' });
    expect(result.current.stale).toBe(true);
  });
});

describe('autosave', () => {
  it('saves after the planner stops typing', async () => {
    const api = fakeApi();
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('aangepast');
    });
    expect(api.saves).toHaveLength(0);

    await settle();
    expect(api.saves).toHaveLength(1);
    expect(result.current.save).toEqual({ kind: 'saved' });
  });

  it('advances the token, so the next save is not a guaranteed conflict', async () => {
    const api = fakeApi();
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('een');
    });
    await settle();
    act(() => {
      result.current.setText('twee');
    });
    await settle();

    expect(api.saves.map((save) => save.token)).toEqual(['absent', 'tok-1']);
  });

  /** Rule 2: never two writes in flight for one training. */
  it('queues the latest draft behind an in-flight save', async () => {
    let release: (() => void) | null = null;
    const api = fakeApi({
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        return new Promise((resolve) => {
          release = () => resolve({ saved: { ...input }, token: `tok-${api.saves.length}` });
        });
      },
    });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('een');
    });
    await settle();
    expect(api.saves).toHaveLength(1);

    act(() => {
      result.current.setText('twee');
    });
    await settle();
    // Still one — the second is waiting.
    expect(api.saves).toHaveLength(1);

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(api.saves).toHaveLength(2);
    expect(api.saves[1].edited).toBe('twee');
  });

  it('reports a failed save and can retry it', async () => {
    let fail = true;
    const api = fakeApi({
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        return fail
          ? Promise.reject(new Error('netwerk weg'))
          : Promise.resolve({ saved: { ...input }, token: 'tok-ok' });
      },
    });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('aangepast');
    });
    await settle();
    expect(result.current.save).toMatchObject({ kind: 'error' });

    fail = false;
    await act(async () => {
      await result.current.retry();
    });

    expect(result.current.save).toEqual({ kind: 'saved' });
  });

  /** A colleague wrote. The draft is kept — the concurrency layer never discards it. */
  it('keeps the draft on a 409', async () => {
    const api = fakeApi({
      saveWhatsapp: () => Promise.reject(new ApiError(409, 'changed')),
    });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('mijn werk');
    });
    await settle();

    expect(result.current.save).toEqual({ kind: 'conflict' });
    expect(result.current.text).toBe('mijn werk');
  });
});

describe('flush', () => {
  it('writes a draft still inside the debounce window', async () => {
    const api = fakeApi();
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('net getypt');
    });
    await act(async () => {
      await result.current.flush();
    });

    expect(api.saves).toHaveLength(1);
    expect(api.saves[0].edited).toBe('net getypt');
  });

  it('reports failure, so the caller can cancel a close', async () => {
    const api = fakeApi({ saveWhatsapp: () => Promise.reject(new Error('nee')) });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('net getypt');
    });

    let outcome: boolean | null = null;
    await act(async () => {
      outcome = await result.current.flush();
    });

    expect(outcome).toBe(false);
    expect(result.current.text).toBe('net getypt');
  });

  it('does nothing when there is nothing to save', async () => {
    const api = fakeApi();
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    await act(async () => {
      await result.current.flush();
    });

    expect(api.saves).toHaveLength(0);
  });
});

describe('changing training', () => {
  it('drops the previous draft rather than showing it over another training', async () => {
    const api = fakeApi();
    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));
    act(() => {
      result.current.setText('training A');
    });

    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    expect(result.current.text).not.toBe('training A');
  });

  /** A response that arrives after the planner has moved on is not theirs to apply. */
  it('ignores a late response for the training that was left', async () => {
    let resolveFirst: ((value: WhatsappPayload) => void) | null = null;
    let call = 0;
    const api = fakeApi({
      getWhatsapp: () => {
        call += 1;
        if (call === 1) {
          return new Promise<WhatsappPayload>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({
          generated: 'TRAINING B',
          saved: null,
          token: 'absent',
          unreadable: false,
          warnings: [],
        });
      },
    });

    const { result, rerender } = open(api);
    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('TRAINING B'));

    await act(async () => {
      resolveFirst?.({
        generated: 'TRAINING A',
        saved: null,
        token: 'absent',
        unreadable: false,
        warnings: [],
      });
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.text).toBe('TRAINING B');
  });
});

/**
 * Rule 3. `Verwerpen` means "drop MY edit", which is not the same as "delete the
 * training's message" — and after an uncertain save it cannot assume either.
 */
describe('discard', () => {
  it('deletes the committed draft when there was nothing saved before it', async () => {
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: { edited: 'mijn draft', base: GENERATED },
          token: 'tok-current',
          unreadable: false,
          warnings: [],
        }),
    });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('mijn draft'));

    await act(async () => {
      await result.current.discard();
    });

    expect(api.discards).toContain('tok-current');
    expect(result.current.text).toBe(GENERATED);
  });

  /**
   * The case that makes a plain delete wrong.
   *
   * The server held S; the planner edited to D; **D committed but its response was
   * lost**, so the client never advanced past S. Discarding must put S back — deleting
   * would wipe a message the planner never asked to remove.
   *
   * Note the precondition: an UNCERTAIN save. A save the client saw succeed has already
   * become the acknowledged state, and "Herstel origineel" then correctly means delete.
   */
  it('restores the previously saved message when an uncertain save had committed', async () => {
    const S = { edited: 'de oude tekst', base: GENERATED };
    let current: { edited: string; base: string } | null = S;
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: current,
          token: 'tok-current',
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        // It lands in Redis — and the reply never reaches the client.
        current = { edited: input.edited, base: input.base };
        return Promise.reject(new Error('verbinding verbroken'));
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(S.edited));

    act(() => {
      result.current.setText('mijn draft');
    });
    await settle();
    expect(result.current.save).toMatchObject({ kind: 'error' });

    // Discard now finds D on the server, and S as the last thing acknowledged.
    api.saveWhatsapp = (_item, input) => {
      api.saves.push(input);
      current = { edited: input.edited, base: input.base };
      return Promise.resolve({ saved: current, token: 'tok-restored' });
    };
    await act(async () => {
      await result.current.discard();
    });

    expect(api.discards).toHaveLength(0);
    expect(api.saves.at(-1)).toMatchObject({ edited: S.edited });
    expect(result.current.text).toBe(S.edited);
  });

  /**
   * And the subtler version: an autosave landed BETWEEN opening and the uncertain one.
   * Restoring the panel-open text would destroy that confirmed intermediate edit — which
   * is why the restore point advances on every acknowledged write.
   */
  it('restores the last acknowledged save, not the text the panel opened with', async () => {
    let current: { edited: string; base: string } | null = { edited: 'S', base: GENERATED };
    let lose = false;
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: current,
          token: 'tok-c',
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        current = { edited: input.edited, base: input.base };
        return lose
          ? Promise.reject(new Error('verbinding verbroken'))
          : Promise.resolve({ saved: current, token: `tok-${api.saves.length}` });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('S'));

    // An intermediate autosave the server acknowledged.
    act(() => {
      result.current.setText('I');
    });
    await settle();
    expect(result.current.save).toEqual({ kind: 'saved' });

    // Then one that commits without the client ever hearing so.
    lose = true;
    act(() => {
      result.current.setText('D');
    });
    await settle();
    expect(result.current.save).toMatchObject({ kind: 'error' });

    lose = false;
    await act(async () => {
      await result.current.discard();
    });

    // I, not S.
    expect(result.current.text).toBe('I');
  });

  it('leaves a colleague’s newer version alone and drops only the local draft', async () => {
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: { edited: 'van een collega', base: GENERATED },
          token: 'tok-theirs',
          unreadable: false,
          warnings: [],
        }),
    });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('van een collega'));

    act(() => {
      result.current.setText('mijn lokale draft');
    });
    await act(async () => {
      await result.current.discard();
    });

    expect(api.discards).toHaveLength(0);
    expect(result.current.text).toBe('van een collega');
  });

  /** If we cannot find out what the server holds, we do not claim to have discarded it. */
  it('reports that it could not check, rather than claiming success', async () => {
    let first = true;
    const api = fakeApi({
      getWhatsapp: () => {
        if (first) {
          first = false;
          return Promise.resolve({
            generated: GENERATED,
            saved: null,
            token: 'absent',
            unreadable: false,
            warnings: [],
          });
        }
        return Promise.reject(new Error('offline'));
      },
    });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('mijn draft');
    });

    let outcome: boolean | null = null;
    await act(async () => {
      outcome = await result.current.discard();
    });

    expect(outcome).toBe(false);
    expect(result.current.save).toMatchObject({ kind: 'error' });
    expect(String((result.current.save as { message: string }).message)).toMatch(/gecontroleerd/);
    expect(result.current.text).toBe('mijn draft');
  });
});

/**
 * The lifecycle edges. Every one of these was a way to lose a planner's typing.
 */
describe('leaving', () => {
  /** Switching training inside the debounce window used to discard the draft outright. */
  it('flushes the draft before changing training', async () => {
    const api = fakeApi();
    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('nog niet opgeslagen');
    });
    // No debounce tick — straight to another training.
    rerender({ id: '999' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(api.saves.map((save) => save.edited)).toContain('nog niet opgeslagen');
    expect(api.saveItems[0]).toBe(ITEM);
  });

  it('flushes on unmount', async () => {
    const api = fakeApi();
    const { result, unmount } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('nog niet opgeslagen');
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(api.saves.map((save) => save.edited)).toContain('nog niet opgeslagen');
  });

  /**
   * Best-effort, and `keepalive` is the only reason it has a chance — the request has to
   * be allowed to outlive the document.
   */
  it('flushes with keepalive when the iframe is hidden', async () => {
    const api = fakeApi();
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('nog niet opgeslagen');
    });

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(api.saves.map((save) => save.edited)).toContain('nog niet opgeslagen');
    expect(api.keepalives.some(Boolean)).toBe(true);
  });

  /**
   * Rule 2, the cross-item case: the queue is keyed by training, so a save that drains
   * after the planner moved on cannot deliver one training's draft to another.
   */
  it('never sends one training’s draft to another', async () => {
    let release: ((value: WhatsappWriteResult) => void) | null = null;
    const api = fakeApi({
      saveWhatsapp: (item, input) => {
        api.saves.push(input);
        api.saveItems.push(item);
        if (api.saves.length === 1) {
          return new Promise<WhatsappWriteResult>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve({ saved: { ...input }, token: 'tok-b' });
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));
    act(() => {
      result.current.setText('van A');
    });
    await settle();
    expect(api.saveItems).toEqual([ITEM]);

    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe(GENERATED));
    act(() => {
      result.current.setText('van B');
    });
    await settle();

    await act(async () => {
      release?.({ saved: { edited: 'van A', base: GENERATED }, token: 'tok-a' });
      await vi.advanceTimersByTimeAsync(20);
    });

    // Each draft went to its own training — never A's queue draining B's text.
    const routed = api.saves.map((save, index) => [api.saveItems[index], save.edited]);
    expect(routed).toContainEqual([ITEM, 'van A']);
    expect(routed).toContainEqual(['999', 'van B']);
    expect(routed).not.toContainEqual([ITEM, 'van B']);
  });
});

describe('an older response landing late', () => {
  /**
   * The quiet one. Clearing `dirty` on every success means an old response can mark the
   * box clean while newer text sits in it — and the next `flush`, on close, then finds
   * nothing to do and drops it.
   */
  it('does not mark newer text clean, so closing still saves it', async () => {
    let release: ((value: WhatsappWriteResult) => void) | null = null;
    const api = fakeApi({
      saveWhatsapp: (item, input) => {
        api.saves.push(input);
        api.saveItems.push(item);
        if (api.saves.length === 1) {
          return new Promise<WhatsappWriteResult>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve({ saved: { ...input }, token: `tok-${api.saves.length}` });
      },
    });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('eerste');
    });
    await settle();
    expect(api.saves).toHaveLength(1);

    // Newer text while the first write is still out.
    act(() => {
      result.current.setText('tweede');
    });

    await act(async () => {
      release?.({ saved: { edited: 'eerste', base: GENERATED }, token: 'tok-1' });
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.dirty).toBe(true);

    await act(async () => {
      await result.current.flush();
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(api.saves.map((save) => save.edited)).toContain('tweede');
  });

  /** Guarded on success, failure AND completion — not just the happy path. */
  it('does not let a failure for the previous training stick to this one', async () => {
    let failFirst: ((reason: Error) => void) | null = null;
    let call = 0;
    const api = fakeApi({
      getWhatsapp: () => {
        call += 1;
        if (call === 1) {
          return new Promise<WhatsappPayload>((_resolve, reject) => {
            failFirst = reject;
          });
        }
        return Promise.resolve({
          generated: 'TRAINING B',
          saved: null,
          token: 'absent',
          unreadable: false,
          warnings: [],
        });
      },
    });

    const { result, rerender } = open(api);
    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('TRAINING B'));

    await act(async () => {
      failFirst?.(new Error('offline'));
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(result.current.loadError).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

describe('discard, against a write already on the wire', () => {
  /**
   * Racing loses: the GET could read the pre-write value and restore it, and the PUT
   * then commits behind us — leaving the "discarded" draft stored.
   */
  it('waits for the in-flight save before reconciling', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    let stored: { edited: string; base: string } | null = null;

    const api = fakeApi({
      getWhatsapp: () => {
        order.push('get');
        return Promise.resolve({
          generated: GENERATED,
          saved: stored,
          token: 'tok-current',
          unreadable: false,
          warnings: [],
        });
      },
      saveWhatsapp: (item, input) => {
        order.push('save');
        api.saves.push(input);
        api.saveItems.push(item);
        return new Promise<WhatsappWriteResult>((resolve) => {
          release = () => {
            stored = { edited: input.edited, base: input.base };
            resolve({ saved: stored, token: 'tok-saved' });
          };
        });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('mijn draft');
    });
    await settle();
    expect(order).toEqual(['get', 'save']);

    const discarding = act(async () => {
      await result.current.discard();
    });

    // The reconciling GET must not have run yet — it is waiting on the save.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(order).toEqual(['get', 'save']);

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(10);
    });
    await discarding;

    expect(order.slice(0, 3)).toEqual(['get', 'save', 'get']);
  });
});

describe('emptying the box', () => {
  /**
   * An empty draft deletes the record, so the editor has to come back to the generated
   * message AND adopt its base — otherwise the next edit saves against a message that is
   * no longer stored, and carries a false stale warning with it.
   */
  it('returns to the generated message and rebases', async () => {
    const api = fakeApi({}, { saved: { edited: 'mijn tekst', base: 'OUDE TEKST' }, token: 'tok-0' });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('mijn tekst'));
    expect(result.current.stale).toBe(true);

    act(() => {
      result.current.setText('   ');
    });
    await settle();

    expect(api.discards).toHaveLength(1);
    expect(result.current.text).toBe(GENERATED);
    expect(result.current.stale).toBe(false);

    act(() => {
      result.current.setText('opnieuw');
    });
    await settle();

    expect(api.saves.at(-1)).toMatchObject({ base: GENERATED });
  });
});

/**
 * The CAS state is per training, not per component.
 *
 * These are the cases where the queue being per-item was not enough: the token and the
 * base have to travel with it, or a write that drains after the planner moved on uses
 * another training's state.
 */
describe('per-training write state', () => {
  it('advances a training’s token even while the planner is looking elsewhere', async () => {
    let release: (() => void) | null = null;
    const tokens: Array<string | undefined> = [];
    const api = fakeApi({
      saveWhatsapp: (item, input) => {
        api.saves.push(input);
        api.saveItems.push(item);
        tokens.push(input.token);
        if (api.saves.length === 1) {
          return new Promise<WhatsappWriteResult>((resolve) => {
            release = () => resolve({ saved: { ...input }, token: 'tok-A1' });
          });
        }
        return Promise.resolve({ saved: { ...input }, token: `tok-${api.saves.length}` });
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    // A: one write on the wire, a second queued behind it.
    act(() => {
      result.current.setText('A eerste');
    });
    await settle();
    act(() => {
      result.current.setText('A tweede');
    });
    await settle();
    expect(api.saves).toHaveLength(1);

    // The planner leaves for B, which loads and takes over the visible state.
    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(20);
    });

    // A's queued write used A's freshly advanced token — not B's, and not the stale one.
    const queued = api.saves.findIndex((save) => save.edited === 'A tweede');
    expect(queued).toBeGreaterThan(-1);
    expect(api.saveItems[queued]).toBe(ITEM);
    expect(tokens[queued]).toBe('tok-A1');
  });

  it('uses each training’s own base', async () => {
    let call = 0;
    const api = fakeApi({
      getWhatsapp: () => {
        call += 1;
        return Promise.resolve({
          generated: call === 1 ? 'BASIS A' : 'BASIS B',
          saved: null,
          token: `tok-${call}`,
          unreadable: false,
          warnings: [],
        });
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe('BASIS A'));
    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));

    act(() => {
      result.current.setText('bewerkt in B');
    });
    await settle();

    expect(api.saves.at(-1)).toMatchObject({ base: 'BASIS B', token: 'tok-2' });
  });
});

describe('discard, once the planner has moved on', () => {
  /**
   * The reconciliation must finish for the training it started on — restoring A's
   * message is right whatever the planner is looking at — but none of it may land in
   * B's textarea.
   */
  it('reconciles the training it started on without touching the visible one', async () => {
    let releaseGet: ((value: WhatsappPayload) => void) | null = null;
    // Keyed by training, not by call order: A is read twice (its load, then the
    // reconciling read) and a counter would hand B's payload to A's discard.
    const readsPerItem = new Map<string, number>();
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        if (item === '999') {
          return Promise.resolve({
            generated: 'BASIS B',
            saved: null,
            token: 'tok-b',
            unreadable: false,
            warnings: [],
          });
        }
        if (nth === 1) {
          return Promise.resolve({
            generated: 'BASIS A',
            saved: { edited: 'A draft', base: 'BASIS A' },
            token: 'tok-a',
            unreadable: false,
            warnings: [],
          });
        }
        // A's reconciling read, held open across the switch to B.
        return new Promise<WhatsappPayload>((resolve) => {
          releaseGet = resolve;
        });
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe('A draft'));

    const discarding = result.current.discard();

    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));

    await act(async () => {
      releaseGet?.({
        generated: 'BASIS A',
        saved: { edited: 'A draft', base: 'BASIS A' },
        token: 'tok-a2',
        unreadable: false,
        warnings: [],
      });
      await discarding;
      await vi.advanceTimersByTimeAsync(20);
    });

    // A's record was discarded on the server…
    expect(api.discards).toContain('tok-a2');
    // …and B's editor was left completely alone.
    expect(result.current.text).toBe('BASIS B');
  });
});

describe('keepalive survives the queue', () => {
  /**
   * The last-gasp save is exactly the one most likely to find the queue busy, and
   * dropping its `keepalive` there defeats the whole point.
   */
  it('promotes a queued lifecycle flush', async () => {
    let release: (() => void) | null = null;
    const api = fakeApi({
      saveWhatsapp: (item, input, options) => {
        api.saves.push(input);
        api.saveItems.push(item);
        api.keepalives.push(options?.keepalive === true);
        if (api.saves.length === 1) {
          return new Promise<WhatsappWriteResult>((resolve) => {
            release = () => resolve({ saved: { ...input }, token: 'tok-1' });
          });
        }
        return Promise.resolve({ saved: { ...input }, token: 'tok-2' });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('eerste');
    });
    await settle();
    expect(api.saves).toHaveLength(1);
    expect(api.keepalives[0]).toBe(false);

    // Newer text, then the iframe goes away while the first write is still out.
    act(() => {
      result.current.setText('tweede');
    });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(10);
    });

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(api.saves.at(-1)?.edited).toBe('tweede');
    expect(api.keepalives.at(-1)).toBe(true);
  });

  /** Clearing the box is a DELETE, and it needs the same treatment. */
  it('applies to an emptied box', async () => {
    const api = fakeApi({}, { saved: { edited: 'iets', base: GENERATED }, token: 'tok-0' });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('iets'));

    act(() => {
      result.current.setText('');
    });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(api.discards).toHaveLength(1);
    expect(api.discardKeepalives.at(-1)).toBe(true);
  });
});

describe('an identical queued draft', () => {
  /**
   * Closing while the current text is already saving queues the same string. The drain
   * drops it without another pass, so counting it as newer work leaves the box dirty
   * forever — and every later lifecycle event rewrites text the server already has.
   */
  it('does not leave the editor permanently dirty', async () => {
    let release: (() => void) | null = null;
    const api = fakeApi({
      saveWhatsapp: (item, input) => {
        api.saves.push(input);
        api.saveItems.push(item);
        return new Promise<WhatsappWriteResult>((resolve) => {
          release = () => resolve({ saved: { ...input }, token: 'tok-1' });
        });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('mijn tekst');
    });
    await settle();
    expect(api.saves).toHaveLength(1);

    // Closing now queues the very same text behind the in-flight write.
    const closing = result.current.flush();

    await act(async () => {
      release?.();
      await closing;
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(result.current.dirty).toBe(false);
    expect(api.saves).toHaveLength(1);
  });
});

/**
 * Identity, not resemblance.
 *
 * Each of these was a case where something looked like the thing we meant — the same
 * training id after a round trip elsewhere, the same visible text from someone else, a
 * snapshot read while our own write was still on the wire.
 */
describe('coming back to a training', () => {
  /**
   * A → B → A. Item equality says the first visit's discard is "still on A", so without
   * an epoch it happily overwrites what the second visit has since loaded.
   */
  it('does not let the first visit’s discard overwrite the second', async () => {
    let releaseGet: ((value: WhatsappPayload) => void) | null = null;
    const readsPerItem = new Map<string, number>();
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        if (item === '999') {
          return Promise.resolve({
            generated: 'BASIS B',
            saved: null,
            token: 'tok-b',
            unreadable: false,
            warnings: [],
          });
        }
        if (nth === 2) {
          // A's reconciling read, held open while the planner goes to B and back.
          return new Promise<WhatsappPayload>((resolve) => {
            releaseGet = resolve;
          });
        }
        return Promise.resolve({
          generated: 'BASIS A',
          saved: { edited: nth === 1 ? 'A draft' : 'A opnieuw', base: 'BASIS A' },
          token: `tok-a${nth}`,
          unreadable: false,
          warnings: [],
        });
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe('A draft'));

    const discarding = result.current.discard();

    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));
    rerender({ id: ITEM });

    // The return visit's load queues behind the first visit's discard rather than
    // racing it. Meanwhile the editor shows A's own last known draft — held on A's
    // record, so coming back does not flash an empty box.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(result.current.text).toBe('A draft');

    await act(async () => {
      releaseGet?.({
        generated: 'BASIS A',
        saved: { edited: 'A draft', base: 'BASIS A' },
        token: 'tok-a-late',
        unreadable: false,
        warnings: [],
      });
      await discarding;
      await vi.advanceTimersByTimeAsync(20);
    });

    // The first visit's discard reconciled on the server but wrote nothing to the UI;
    // the return visit's own load is what the planner ends up looking at.
    await waitFor(() => expect(result.current.text).toBe('A opnieuw'));
  });

  /**
   * The departure save for A can still be on the wire when the planner returns and A is
   * read again. Applying that pre-save snapshot would regress the token and call the
   * stale text clean — and the write would then land behind an editor showing the old
   * value.
   */
  it('waits for its own write before re-reading a training', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    let stored: { edited: string; base: string } | null = null;

    const api = fakeApi({
      getWhatsapp: (item: string) => {
        order.push(`get:${item}`);
        return Promise.resolve({
          generated: GENERATED,
          saved: item === ITEM ? stored : null,
          token: 'tok-read',
          unreadable: false,
          warnings: [],
        });
      },
      saveWhatsapp: (item, input) => {
        order.push(`save:${item}`);
        api.saves.push(input);
        api.saveItems.push(item);
        return new Promise<WhatsappWriteResult>((resolve) => {
          release = () => {
            stored = { edited: input.edited, base: input.base };
            resolve({ saved: stored, token: 'tok-written' });
          };
        });
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    // Type, then leave immediately — the departure flush goes out.
    act(() => {
      result.current.setText('onderweg');
    });
    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe(GENERATED));
    expect(order).toContain(`save:${ITEM}`);

    // Come straight back while that write is still unresolved.
    rerender({ id: ITEM });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    // The re-read has NOT happened yet: it is waiting on our own write.
    expect(order.filter((entry) => entry === `get:${ITEM}`)).toHaveLength(1);

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(20);
    });

    // Now it reads, and sees the text it just wrote.
    expect(order.filter((entry) => entry === `get:${ITEM}`)).toHaveLength(2);
    await waitFor(() => expect(result.current.text).toBe('onderweg'));
    expect(result.current.dirty).toBe(false);
  });
});

describe('recognising our own draft', () => {
  /**
   * `edited` alone does not identify a record. A colleague can save the same visible
   * text against a newer generated base — discarding would then delete their version
   * while telling the planner we merely dropped a local draft.
   */
  it('does not delete a colleague’s message that happens to read the same', async () => {
    const readsPerItem = new Map<string, number>();
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        return Promise.resolve(
          nth === 1
            ? {
                generated: 'BASIS OUD',
                saved: null,
                token: 'tok-1',
                unreadable: false,
                warnings: [],
              }
            : {
                // Same words, saved by someone else against the NEW generated message.
                generated: 'BASIS NIEUW',
                saved: { edited: 'zelfde tekst', base: 'BASIS NIEUW' },
                token: 'tok-2',
                unreadable: false,
                warnings: [],
              }
        );
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('BASIS OUD'));

    act(() => {
      result.current.setText('zelfde tekst');
    });

    await act(async () => {
      await result.current.discard();
    });

    expect(api.discards).toHaveLength(0);
    expect(result.current.text).toBe('zelfde tekst');
  });

  it('still deletes a record that really is ours', async () => {
    const api = fakeApi(
      {},
      { saved: { edited: 'mijn draft', base: GENERATED }, token: 'tok-current' }
    );
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('mijn draft'));

    await act(async () => {
      await result.current.discard();
    });

    expect(api.discards).toContain('tok-current');
  });
});

describe('one lock per training', () => {
  /**
   * A discard is a read-decide-write, and all three have to be inside the lock. Waiting
   * on an in-flight save without JOINING the queue let a load slip in mid-reconciliation,
   * read the old message, mark it clean, and then have the DELETE land behind it.
   */
  it('makes a load wait for a discard already reconciling', async () => {
    const order: string[] = [];
    let releaseGet: ((value: WhatsappPayload) => void) | null = null;
    const readsPerItem = new Map<string, number>();

    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        order.push(`get${nth}`);
        if (nth === 2) {
          return new Promise<WhatsappPayload>((resolve) => {
            releaseGet = resolve;
          });
        }
        return Promise.resolve({
          generated: GENERATED,
          saved: { edited: 'mijn draft', base: GENERATED },
          token: `tok-${nth}`,
          unreadable: false,
          warnings: [],
        });
      },
      discardWhatsapp: (_item, token) => {
        order.push('delete');
        api.discards.push(token);
        return Promise.resolve({ saved: null, token: 'tok-gone' });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('mijn draft'));

    const discarding = result.current.discard();
    const reloading = result.current.reload();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    // The reload has not issued its GET: the discard holds the lock.
    expect(order).toEqual(['get1', 'get2']);

    await act(async () => {
      releaseGet?.({
        generated: GENERATED,
        saved: { edited: 'mijn draft', base: GENERATED },
        token: 'tok-2',
        unreadable: false,
        warnings: [],
      });
      await discarding;
      await reloading;
      await vi.advanceTimersByTimeAsync(20);
    });

    // DELETE happened before the reload's read — never interleaved with it.
    expect(order).toEqual(['get1', 'get2', 'delete', 'get3']);
  });
});

describe('a corrupt stored record', () => {
  /**
   * The API reports it as `saved: null` plus a warning and a usable token. Reading that
   * as "nothing is stored" sent the discard down the preservation branch, so the corrupt
   * value — and its warning — stayed put forever, with no way for a planner to clear it.
   */
  it('can be cleared with Herstel origineel', async () => {
    let corrupt = true;
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: null,
          token: corrupt ? 'tok-corrupt' : 'absent',
          unreadable: corrupt,
          warnings: ['De kolom voor "tijden" ontbreekt op het board; die regel is weggelaten.'],
        }),
      discardWhatsapp: (_item, token) => {
        api.discards.push(token);
        corrupt = false;
        return Promise.resolve({ saved: null, token: 'tok-gone' });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.unreadable).toBe(true));

    await act(async () => {
      await result.current.discard();
    });

    expect(api.discards).toContain('tok-corrupt');
    expect(result.current.unreadable).toBe(false);
    expect(result.current.text).toBe(GENERATED);
  });

  /** And an ordinary absent record still takes the preservation branch, untouched. */
  it('is not confused with nothing being stored', async () => {
    const api = fakeApi();
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    await act(async () => {
      await result.current.discard();
    });

    expect(api.discards).toHaveLength(0);
  });
});

describe('discarding, then closing', () => {
  /**
   * Herstel origineel followed by Sluiten before reconciliation lands.
   *
   * The close-flush used to queue the pre-discard text behind the discard: the discard
   * restored the original, the queued PUT wrote the discarded draft straight back over
   * it, and the panel closed reporting success. A discard is the one operation whose
   * pending draft must NOT be flushed — it is the text being thrown away.
   */
  it('does not save the draft that was just discarded', async () => {
    let releaseGet: ((value: WhatsappPayload) => void) | null = null;
    const readsPerItem = new Map<string, number>();
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        if (nth === 2) {
          return new Promise<WhatsappPayload>((resolve) => {
            releaseGet = resolve;
          });
        }
        return Promise.resolve({
          generated: GENERATED,
          saved: { edited: 'origineel', base: GENERATED },
          token: 'tok-1',
          unreadable: false,
          warnings: [],
        });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('origineel'));

    act(() => {
      result.current.setText('werk in uitvoering');
    });

    const discarding = result.current.discard();
    // Sluiten, while the reconciliation is still out.
    const closing = result.current.flush();

    // Let the reconciliation reach its read before releasing it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });
    expect(releaseGet).not.toBeNull();

    await act(async () => {
      releaseGet?.({
        generated: GENERATED,
        saved: { edited: 'origineel', base: GENERATED },
        token: 'tok-2',
        unreadable: false,
        warnings: [],
      });
      await discarding;
      await closing;
      await vi.advanceTimersByTimeAsync(20);
    });

    // The discarded text was never written back.
    expect(api.saves.map((save) => save.edited)).not.toContain('werk in uitvoering');
    expect(result.current.text).toBe('origineel');
    expect(result.current.dirty).toBe(false);
  });

  it('still reports success, so the panel may close', async () => {
    const api = fakeApi({}, { saved: { edited: 'origineel', base: GENERATED }, token: 'tok-1' });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('origineel'));

    act(() => {
      result.current.setText('werk in uitvoering');
    });

    let closed: boolean | null = null;
    const discarding = result.current.discard();
    const closing = result.current.flush();
    await act(async () => {
      await discarding;
      closed = await closing;
      await vi.advanceTimersByTimeAsync(10);
    });

    expect(closed).toBe(true);
  });
});

describe('recovering from a corrupt record', () => {
  const corruptThenClean = (): { api: ReturnType<typeof fakeApi>; healthy: () => void } => {
    let corrupt = true;
    const DRIFT = 'De kolom voor "tijden" ontbreekt op het board; die regel is weggelaten.';
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: null,
          token: corrupt ? 'tok-corrupt' : 'absent',
          unreadable: corrupt,
          // An UNRELATED warning, which must survive the recovery.
          warnings: [DRIFT],
        }),
    });
    return {
      api,
      healthy: () => {
        corrupt = false;
      },
    };
  };

  it('keeps the unrelated warnings when Herstel origineel clears it', async () => {
    const { api } = corruptThenClean();
    const { result } = open(api);
    await waitFor(() => expect(result.current.unreadable).toBe(true));

    await act(async () => {
      await result.current.discard();
    });

    expect(result.current.unreadable).toBe(false);
    // The drift warning is about the board, not about the record we just removed.
    expect(result.current.warnings).toHaveLength(1);
    expect(result.current.warnings[0]).toMatch(/tijden/);
  });

  /** The other recovery path: simply typing over it. */
  it('clears the notice when a save overwrites the corrupt record', async () => {
    const { api } = corruptThenClean();
    const { result } = open(api);
    await waitFor(() => expect(result.current.unreadable).toBe(true));

    act(() => {
      result.current.setText('nieuwe tekst');
    });
    await settle();

    expect(api.saves).toHaveLength(1);
    expect(result.current.unreadable).toBe(false);
    expect(result.current.warnings).toHaveLength(1);
  });
});

/**
 * The draft belongs to the training, not to the component.
 *
 * The queue was made per-item three rounds ago; the text it carries was not, and these
 * are the three places that gap showed.
 */
describe('drafts are per training', () => {
  it('never writes the visible training’s text to the one being left', async () => {
    let releaseDiscardGet: ((value: WhatsappPayload) => void) | null = null;
    const readsPerItem = new Map<string, number>();
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        if (item === ITEM && nth === 2) {
          return new Promise<WhatsappPayload>((resolve) => {
            releaseDiscardGet = resolve;
          });
        }
        return Promise.resolve({
          generated: item === ITEM ? 'BASIS A' : 'BASIS B',
          saved: item === ITEM ? { edited: 'A tekst', base: 'BASIS A' } : null,
          token: `tok-${item}-${nth}`,
          unreadable: false,
          warnings: [],
        });
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe('A tekst'));

    // Restore A, then leave and type in B while A is still reconciling.
    const discarding = result.current.discard();
    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));
    act(() => {
      result.current.setText('B tekst');
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
      releaseDiscardGet?.({
        generated: 'BASIS A',
        saved: { edited: 'A tekst', base: 'BASIS A' },
        token: 'tok-a-late',
        unreadable: false,
        warnings: [],
      });
      await discarding;
      await vi.advanceTimersByTimeAsync(2000);
    });

    // B's text went to B, and nothing at all went to A under B's name.
    const routed = api.saves.map((save, index) => [api.saveItems[index], save.edited]);
    expect(routed).not.toContainEqual([ITEM, 'B tekst']);
    expect(routed.filter(([item]) => item === '999')).toContainEqual(['999', 'B tekst']);
  });

  /**
   * The textarea stays writable while a restore is in flight. Typing during it must win
   * — otherwise the settled value silently replaces the new text and marks it clean, and
   * its debounce then saves something nobody can see.
   */
  it('keeps text typed while a restore is still pending', async () => {
    let releaseGet: ((value: WhatsappPayload) => void) | null = null;
    const readsPerItem = new Map<string, number>();
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        if (nth === 2) {
          return new Promise<WhatsappPayload>((resolve) => {
            releaseGet = resolve;
          });
        }
        return Promise.resolve({
          generated: GENERATED,
          saved: { edited: 'origineel', base: GENERATED },
          token: 'tok-1',
          unreadable: false,
          warnings: [],
        });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('origineel'));

    const discarding = result.current.discard();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });

    // The planner carries on typing while the restore is out.
    act(() => {
      result.current.setText('ondertussen getypt');
    });

    await act(async () => {
      releaseGet?.({
        generated: GENERATED,
        saved: { edited: 'origineel', base: GENERATED },
        token: 'tok-2',
        unreadable: false,
        warnings: [],
      });
      await discarding;
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(result.current.text).toBe('ondertussen getypt');
    expect(result.current.dirty).toBe(true);
  });

  /**
   * A departure save that fails once the planner is elsewhere used to be reported as
   * success and forgotten — so coming back loaded the old server value straight over
   * work that was never stored.
   */
  it('holds on to a departure save that failed, and surfaces it on return', async () => {
    let failSave = true;
    const readsPerItem = new Map<string, number>();
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        return Promise.resolve({
          generated: item === ITEM ? 'BASIS A' : 'BASIS B',
          saved: null,
          token: `tok-${item}-${nth}`,
          unreadable: false,
          warnings: [],
        });
      },
      saveWhatsapp: (item, input) => {
        api.saves.push(input);
        api.saveItems.push(item);
        return failSave
          ? Promise.reject(new Error('netwerk weg'))
          : Promise.resolve({ saved: { ...input }, token: 'tok-ok' });
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe('BASIS A'));

    act(() => {
      result.current.setText('werk dat verloren mocht gaan');
    });
    // Leave immediately: the departure flush fires and rejects after B is active.
    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    failSave = false;
    rerender({ id: ITEM });
    await waitFor(() => expect(result.current.text).toBe('werk dat verloren mocht gaan'));

    // Not silently dropped, and the planner is told why it is still unsaved.
    expect(result.current.dirty).toBe(true);
    expect(result.current.save).toMatchObject({ kind: 'error' });
  });
});

/**
 * What a retained failure means.
 *
 * Keeping unsaved work across a switch was the easy half. The hard half is that the
 * retained thing has to remember WHICH revision it was attempted against, and whether it
 * is even worth retrying.
 */
describe('a retained failure', () => {
  const failingApi = (options: { status?: number } = {}) => {
    let fail = true;
    const readsPerItem = new Map<string, number>();
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        return Promise.resolve({
          generated: item === ITEM ? 'BASIS A' : 'BASIS B',
          // On the RETURN visit a colleague has written and the message has moved on.
          saved:
            item === ITEM && nth > 1 ? { edited: 'van een collega', base: 'BASIS NIEUW' } : null,
          token: item === ITEM && nth > 1 ? 'tok-nieuw' : `tok-${item}-1`,
          unreadable: false,
          warnings: [],
        });
      },
      saveWhatsapp: (item, input) => {
        api.saves.push(input);
        api.saveItems.push(item);
        if (!fail) {
          return Promise.resolve({ saved: { ...input }, token: 'tok-ok' });
        }
        return Promise.reject(
          options.status === 409
            ? new ApiError(409, 'changed')
            : new Error('netwerk weg')
        );
      },
    });
    return { api, succeed: () => (fail = false) };
  };

  /**
   * The retry must be made against the revision the attempt was made against. Adopting
   * the token from the return read would let it overwrite the colleague with no conflict
   * to notice, and adopting their base would rebase the edit so its staleness warning
   * vanished by itself.
   */
  it('retries against its own revision, not one read later', async () => {
    const { api, succeed } = failingApi();
    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe('BASIS A'));

    act(() => {
      result.current.setText('mijn werk');
    });
    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });

    const attempted = api.saves.at(-1);
    rerender({ id: ITEM });
    await waitFor(() => expect(result.current.text).toBe('mijn werk'));

    succeed();
    await act(async () => {
      await result.current.retry();
    });

    // The same token and base as the original attempt — so the CAS still gets to refuse.
    expect(api.saves.at(-1)).toMatchObject({
      token: attempted?.token,
      base: attempted?.base,
    });
  });

  /** A conflict is not unsaved work — it is a decision. */
  it('remembers a 409 as a conflict rather than something to retry', async () => {
    const { api } = failingApi({ status: 409 });
    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe('BASIS A'));

    act(() => {
      result.current.setText('mijn werk');
    });
    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    rerender({ id: ITEM });

    await waitFor(() => expect(result.current.save).toEqual({ kind: 'conflict' }));
    expect(result.current.text).toBe('mijn werk');
  });

  /** …and Herladen then actually takes theirs. */
  it('lets Herladen accept the server version', async () => {
    const { api } = failingApi({ status: 409 });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('BASIS A'));

    act(() => {
      result.current.setText('mijn werk');
    });
    await settle();
    expect(result.current.save).toEqual({ kind: 'conflict' });

    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.text).toBe('van een collega');
    expect(result.current.dirty).toBe(false);
    expect(result.current.save).toEqual({ kind: 'idle' });
  });

  /** Text typed after the failure is newer than the failed attempt and must survive. */
  it('does not overwrite text typed after the failure', async () => {
    const { api } = failingApi();
    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe('BASIS A'));

    act(() => {
      result.current.setText('eerste poging');
    });
    await settle();
    act(() => {
      result.current.setText('daarna nog getypt');
    });

    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));
    rerender({ id: ITEM });

    await waitFor(() => expect(result.current.text).toBe('daarna nog getypt'));
  });

  /** A retry that lands while the planner is elsewhere still clears the failure. */
  it('is cleared by a success that happens off-screen', async () => {
    let release: (() => void) | null = null;
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> =>
        Promise.resolve({
          generated: item === ITEM ? 'BASIS A' : 'BASIS B',
          saved: null,
          token: `tok-${item}`,
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (item, input) => {
        api.saves.push(input);
        api.saveItems.push(item);
        return new Promise<WhatsappWriteResult>((resolve) => {
          release = () => resolve({ saved: { ...input }, token: 'tok-ok' });
        });
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe('BASIS A'));

    act(() => {
      result.current.setText('mijn werk');
    });
    // The departure save goes out and stays out while the planner moves on.
    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));

    await act(async () => {
      release?.();
      await vi.advanceTimersByTimeAsync(20);
    });

    rerender({ id: ITEM });
    await waitFor(() => expect(result.current.text).toBe('BASIS A'));

    // No error for text the server already has.
    expect(result.current.save).not.toMatchObject({ kind: 'error' });
    expect(result.current.dirty).toBe(false);
  });
});

describe('restoring after an uncertain save', () => {
  /**
   * D1 commits, its response is lost, the planner types D2 and presses Herstel
   * origineel. The read returns D1 — not what is on screen, but still ours. Comparing
   * only against the textarea left our own orphaned write in place forever.
   */
  it('recognises a committed earlier attempt as ours', async () => {
    let stored: { edited: string; base: string } | null = null;
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: stored,
          token: 'tok-current',
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        // It lands, and the reply never arrives.
        stored = { edited: input.edited, base: input.base };
        return Promise.reject(new Error('verbinding verbroken'));
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('D1');
    });
    await settle();
    expect(result.current.save).toMatchObject({ kind: 'error' });

    // The planner carries on typing, then asks for the original back.
    act(() => {
      result.current.setText('D2');
    });
    await act(async () => {
      await result.current.discard();
    });

    // D1 was ours, so it is removed rather than mistaken for a colleague's.
    expect(api.discards).toHaveLength(1);
    expect(result.current.text).toBe(GENERATED);
  });

  /** And the obsolete failure goes with it, instead of resurfacing on the next open. */
  it('clears the retained failure', async () => {
    let stored: { edited: string; base: string } | null = null;
    let fail = true;
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: stored,
          token: 'tok-current',
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        stored = { edited: input.edited, base: input.base };
        return fail
          ? Promise.reject(new Error('verbinding verbroken'))
          : Promise.resolve({ saved: stored, token: 'tok-ok' });
      },
      discardWhatsapp: (_item, token) => {
        api.discards.push(token);
        stored = null;
        return Promise.resolve({ saved: null, token: 'tok-gone' });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('mislukt');
    });
    await settle();
    expect(result.current.save).toMatchObject({ kind: 'error' });

    fail = false;
    await act(async () => {
      await result.current.discard();
    });
    expect(result.current.save).toEqual({ kind: 'idle' });

    // Reopening must not resurrect the discarded edit or its error.
    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.text).toBe(GENERATED);
    expect(result.current.save).toEqual({ kind: 'idle' });
    expect(result.current.dirty).toBe(false);
  });
});

/**
 * What a retained record still describes after the world has moved.
 *
 * Each of these is a value that was correct when it was written and quietly stopped
 * being correct — a restore point overwritten by a later read, a revision inherited from
 * somebody else, a staleness check measured against the wrong base.
 */
describe('a retained failure keeps its bearings', () => {
  /**
   * Server holds S. Our D commits with its reply lost. The planner comes back BEFORE
   * pressing Herstel origineel, so the load reads D — and adopting D as the last
   * acknowledged value would make the restore delete D rather than put S back.
   */
  it('still knows what to restore after reading its own uncertain write', async () => {
    const S = { edited: 'de oude tekst', base: GENERATED };
    let stored: { edited: string; base: string } | null = S;
    let landWithoutReply = true;

    const api = fakeApi({
      // Item-aware: the detour to another training must not be served this one's record.
      getWhatsapp: (item: string) =>
        Promise.resolve({
          generated: item === ITEM ? GENERATED : 'BASIS B',
          saved: item === ITEM ? stored : null,
          token: `tok-read-${item}`,
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        stored = { edited: input.edited, base: input.base };
        if (landWithoutReply) {
          return Promise.reject(new Error('verbinding verbroken'));
        }
        return Promise.resolve({ saved: stored, token: 'tok-restored' });
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe(S.edited));

    act(() => {
      result.current.setText('D');
    });
    await settle();
    expect(result.current.save).toMatchObject({ kind: 'error' });

    // Away and back — the load now reads D, our own orphaned write.
    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));
    rerender({ id: ITEM });
    await waitFor(() => expect(result.current.text).toBe('D'));

    landWithoutReply = false;
    await act(async () => {
      await result.current.discard();
    });

    // S comes back, written — not deleted along with D.
    expect(api.discards).toHaveLength(0);
    expect(api.saves.at(-1)).toMatchObject({ edited: S.edited });
    expect(result.current.text).toBe(S.edited);
  });

  /**
   * Typing while a restore is in flight, when the read turns up a colleague's message.
   * Adopting their token would let the new text overwrite them with no conflict at all.
   */
  it('does not let text typed during a restore inherit a colleague’s revision', async () => {
    let releaseGet: ((value: WhatsappPayload) => void) | null = null;
    const readsPerItem = new Map<string, number>();
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        if (nth === 2) {
          return new Promise<WhatsappPayload>((resolve) => {
            releaseGet = resolve;
          });
        }
        return Promise.resolve({
          generated: GENERATED,
          saved: { edited: 'van mij', base: GENERATED },
          token: 'tok-mijn',
          unreadable: false,
          warnings: [],
        });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('van mij'));

    const discarding = result.current.discard();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });

    act(() => {
      result.current.setText('ondertussen getypt');
    });

    await act(async () => {
      // A colleague got there first, with their own revision.
      releaseGet?.({
        generated: GENERATED,
        saved: { edited: 'van een collega', base: GENERATED },
        token: 'tok-collega',
        unreadable: false,
        warnings: [],
      });
      await discarding;
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(result.current.text).toBe('ondertussen getypt');

    // The save that follows carries OUR revision, so the CAS can still refuse.
    await act(async () => {
      await result.current.flush();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(api.saves.at(-1)?.token).toBe('tok-mijn');
    expect(api.saves.at(-1)?.token).not.toBe('tok-collega');
  });

  /**
   * With a retained failure, `saved` describes the freshly read server value while the
   * textarea holds the local attempt. Measuring staleness against the former called a
   * draft written from an older message "current".
   */
  it('measures staleness against the base of the text on screen', async () => {
    let generated = 'BASIS OUD';
    const api = fakeApi({
      getWhatsapp: (item: string) =>
        Promise.resolve({
          generated: item === ITEM ? generated : 'BASIS B',
          // A colleague's message on THIS training, based on the current generated text.
          saved:
            item === ITEM && generated !== 'BASIS OUD'
              ? { edited: 'van een collega', base: generated }
              : null,
          token: `tok-${item}`,
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        return Promise.reject(new Error('netwerk weg'));
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe('BASIS OUD'));

    act(() => {
      result.current.setText('mijn werk, op de oude basis');
    });
    await settle();
    expect(result.current.save).toMatchObject({ kind: 'error' });

    // The training changes while we are away, and a colleague saves against the new one.
    generated = 'BASIS NIEUW';
    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));
    rerender({ id: ITEM });
    await waitFor(() => expect(result.current.text).toBe('mijn werk, op de oude basis'));

    // The draft on screen was written against BASIS OUD, so it IS stale — even though
    // the server's own record happens to match the current message.
    expect(result.current.stale).toBe(true);
  });
});

describe('more than one attempt may be outstanding', () => {
  /**
   * D1 fails in transport — possibly landing. A retry comes back 409, which definitively
   * did not land. Keeping only the latest failure meant the record described the 409 and
   * forgot D1, so a restore no longer recognised D1 on the server and preserved our own
   * orphan as if a colleague had written it.
   */
  it('still recognises an earlier uncertain write after a retry conflicts', async () => {
    let stored: { edited: string; base: string } | null = null;
    let mode: 'lose' | 'conflict' | 'ok' = 'lose';

    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: stored,
          token: 'tok-read',
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        if (mode === 'lose') {
          // Lands in Redis; the reply never arrives.
          stored = { edited: input.edited, base: input.base };
          return Promise.reject(new Error('verbinding verbroken'));
        }
        if (mode === 'conflict') {
          return Promise.reject(new ApiError(409, 'changed'));
        }
        stored = { edited: input.edited, base: input.base };
        return Promise.resolve({ saved: stored, token: 'tok-ok' });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('D1');
    });
    await settle();
    expect(result.current.save).toMatchObject({ kind: 'error' });

    // The retry is refused outright.
    mode = 'conflict';
    act(() => {
      result.current.setText('D2');
    });
    await settle();
    expect(result.current.save).toEqual({ kind: 'conflict' });

    // Restore: the server holds D1, which is still ours even though the last failure
    // was about D2.
    mode = 'ok';
    await act(async () => {
      await result.current.discard();
    });

    expect(api.discards).toHaveLength(1);
    expect(result.current.text).toBe(GENERATED);
  });

  it('forgets them all once a save succeeds', async () => {
    let stored: { edited: string; base: string } | null = null;
    let lose = true;
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: stored,
          token: 'tok-read',
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        stored = { edited: input.edited, base: input.base };
        return lose
          ? Promise.reject(new Error('verbinding verbroken'))
          : Promise.resolve({ saved: stored, token: 'tok-ok' });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('D1');
    });
    await settle();

    lose = false;
    act(() => {
      result.current.setText('D2');
    });
    await settle();
    expect(result.current.save).toEqual({ kind: 'saved' });

    // D2 is genuinely stored, so a restore removes it rather than treating the settled
    // record as somebody else's.
    await act(async () => {
      await result.current.discard();
    });
    expect(api.discards).toHaveLength(1);
  });
});

describe('clearing a corrupt record while typing', () => {
  /**
   * The tombstone we just wrote is the current revision, so the queued edit must save
   * against it. Reverting to the pre-discard token — right for a colleague's message —
   * would make it conflict with a record nobody else ever touched.
   */
  it('keeps the tombstone token for text typed during the cleanup', async () => {
    let releaseGet: ((value: WhatsappPayload) => void) | null = null;
    const readsPerItem = new Map<string, number>();
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        if (nth === 2) {
          return new Promise<WhatsappPayload>((resolve) => {
            releaseGet = resolve;
          });
        }
        return Promise.resolve({
          generated: GENERATED,
          saved: null,
          token: 'tok-corrupt',
          unreadable: true,
          warnings: [],
        });
      },
      discardWhatsapp: (_item, token) => {
        api.discards.push(token);
        return Promise.resolve({ saved: null, token: 'tok-tombstone' });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.unreadable).toBe(true));

    const discarding = result.current.discard();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });

    act(() => {
      result.current.setText('ondertussen getypt');
    });

    await act(async () => {
      releaseGet?.({
        generated: GENERATED,
        saved: null,
        token: 'tok-corrupt-2',
        unreadable: true,
        warnings: [],
      });
      await discarding;
      await vi.advanceTimersByTimeAsync(20);
    });

    await act(async () => {
      await result.current.flush();
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(api.saves.at(-1)).toMatchObject({
      edited: 'ondertussen getypt',
      token: 'tok-tombstone',
    });
  });
});

describe('reopening with several attempts outstanding', () => {
  /**
   * D1 commits with its reply lost; D2 later fails; the planner leaves and returns. The
   * read can return D1 while the latest failure describes D2 — so matching only the
   * latest would adopt D1 as the last acknowledged value, and Herstel origineel would
   * restore D1 rather than the message that preceded it.
   */
  it('recognises any outstanding attempt, not just the newest', async () => {
    const S = { edited: 'de oude tekst', base: GENERATED };
    let stored: { edited: string; base: string } | null = S;
    let mode: 'lose' | 'ok' = 'lose';

    const api = fakeApi({
      getWhatsapp: (item: string) =>
        Promise.resolve({
          generated: item === ITEM ? GENERATED : 'BASIS B',
          saved: item === ITEM ? stored : null,
          token: `tok-${item}`,
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        if (mode === 'lose') {
          // D1 lands; D2 does not, because its token is now stale — but from here both
          // simply fail without a reply.
          if (api.saves.length === 1) {
            stored = { edited: input.edited, base: input.base };
          }
          return Promise.reject(new Error('verbinding verbroken'));
        }
        stored = { edited: input.edited, base: input.base };
        return Promise.resolve({ saved: stored, token: 'tok-ok' });
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe(S.edited));

    act(() => {
      result.current.setText('D1');
    });
    await settle();
    act(() => {
      result.current.setText('D2');
    });
    await settle();
    expect(api.saves).toHaveLength(2);

    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));
    rerender({ id: ITEM });
    await waitFor(() => expect(result.current.text).toBe('D2'));

    mode = 'ok';
    await act(async () => {
      await result.current.discard();
    });

    // The pre-D1 message comes back — not D1, which was ours and orphaned.
    expect(result.current.text).toBe(S.edited);
  });

  /**
   * Neither end can be evicted safely — the oldest may have committed before the token
   * moved, and the newest may be the first that reached Redis at all — so the bound is
   * set high enough that a run of failures like this never reaches it.
   */
  it('keeps every attempt through a long run of failures', async () => {
    let stored: { edited: string; base: string } | null = null;
    let mode: 'lose' | 'ok' = 'lose';
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: stored,
          token: 'tok-read',
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        if (mode === 'lose') {
          if (api.saves.length === 1) {
            stored = { edited: input.edited, base: input.base };
          }
          return Promise.reject(new Error('verbinding verbroken'));
        }
        stored = { edited: input.edited, base: input.base };
        return Promise.resolve({ saved: stored, token: 'tok-ok' });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    // Well past the cap, so an oldest-first eviction would have dropped D1.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      act(() => {
        result.current.setText(`D${n}`);
      });
      await settle();
    }
    expect(api.saves.length).toBeLessThan(MAX_UNCERTAIN_ATTEMPTS);

    mode = 'ok';
    await act(async () => {
      await result.current.discard();
    });

    // D1 is what is actually stored, and it is still recognised as ours.
    expect(api.discards).toHaveLength(1);
    expect(result.current.text).toBe(GENERATED);
  });
});

describe('a restore that fails', () => {
  it('does not let the close fall through to saving the draft', async () => {
    let failGet = false;
    const api = fakeApi({
      getWhatsapp: () =>
        failGet
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({
              generated: GENERATED,
              saved: { edited: 'origineel', base: GENERATED },
              token: 'tok-1',
              unreadable: false,
              warnings: [],
            }),
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('origineel'));

    act(() => {
      result.current.setText('te verwerpen');
    });

    failGet = true;
    const discarding = result.current.discard();
    const closing = result.current.flush();

    let closed: boolean | null = null;
    await act(async () => {
      await discarding;
      closed = await closing;
      await vi.advanceTimersByTimeAsync(20);
    });

    // The panel stays open, and the text it was asked to remove was not written back.
    expect(closed).toBe(false);
    expect(api.saves).toHaveLength(0);
  });
});

describe('restoring, then leaving before it lands', () => {
  /**
   * Edit A, start restoring it, switch to B. A's departure flush waits for the restore —
   * and then, if the queue was never settled, saves the obsolete dirty draft straight
   * back over what was just restored.
   */
  it('does not write the pre-restore draft back over the restored message', async () => {
    let releaseGet: ((value: WhatsappPayload) => void) | null = null;
    const readsPerItem = new Map<string, number>();
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        if (item === ITEM && nth === 2) {
          return new Promise<WhatsappPayload>((resolve) => {
            releaseGet = resolve;
          });
        }
        return Promise.resolve({
          generated: item === ITEM ? GENERATED : 'BASIS B',
          saved: item === ITEM ? { edited: 'origineel', base: GENERATED } : null,
          token: `tok-${item}`,
          unreadable: false,
          warnings: [],
        });
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe('origineel'));

    act(() => {
      result.current.setText('te verwerpen');
    });
    const discarding = result.current.discard();

    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));

    await act(async () => {
      releaseGet?.({
        generated: GENERATED,
        saved: { edited: 'origineel', base: GENERATED },
        token: 'tok-2',
        unreadable: false,
        warnings: [],
      });
      await discarding;
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(api.saves.map((save) => save.edited)).not.toContain('te verwerpen');
  });
});

describe('when the record of attempts is incomplete', () => {
  /**
   * Eviction is unsafe from either end, so the bound is high — but if it is ever reached,
   * "not one of ours" stops being evidence of a colleague's message. Preserving what may
   * be our own orphan is the exact failure this apparatus exists to prevent, so the
   * planner is asked instead of being told.
   */
  it('refuses to assume an unrecognised record belongs to somebody else', async () => {
    let stored: { edited: string; base: string } | null = null;
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: stored,
          token: 'tok-read',
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        /**
         * Every one of these fails without a reply, and the one that quietly landed is
         * past the bound — so it is precisely the attempt we could not keep a record of.
         */
        if (api.saves.length === MAX_UNCERTAIN_ATTEMPTS + 2) {
          stored = { edited: input.edited, base: input.base };
        }
        return Promise.reject(new Error('verbinding verbroken'));
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    // Past the bound, so the record of attempts is knowingly incomplete.
    for (let n = 1; n <= MAX_UNCERTAIN_ATTEMPTS + 3; n += 1) {
      act(() => {
        result.current.setText(`D${n}`);
      });
      await settle();
    }

    await act(async () => {
      await result.current.discard();
    });

    // Not silently preserved as a colleague's, and not blindly deleted either.
    expect(api.discards).toHaveLength(0);
    expect(result.current.save).toEqual({ kind: 'conflict' });
  });

  it('says nothing of the sort while the record is still complete', async () => {
    const api = fakeApi({}, { saved: { edited: 'van een collega', base: GENERATED }, token: 't' });
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('van een collega'));

    act(() => {
      result.current.setText('mijn lokale draft');
    });
    await act(async () => {
      await result.current.discard();
    });

    // A complete record makes "not ours" trustworthy: theirs is kept, quietly.
    expect(result.current.text).toBe('van een collega');
    expect(result.current.save).toEqual({ kind: 'idle' });
  });
});

describe('detecting edits during a restore', () => {
  /**
   * Type a character and undo it and the text is unchanged, so comparing strings
   * concludes nothing happened — and the settled value then replaces the planner's
   * latest text and marks it clean. A revision counter cannot be fooled by a round trip.
   */
  it('notices typing that ends on the text it started from', async () => {
    let releaseGet: ((value: WhatsappPayload) => void) | null = null;
    const readsPerItem = new Map<string, number>();
    const api = fakeApi({
      getWhatsapp: (item: string): Promise<WhatsappPayload> => {
        const nth = (readsPerItem.get(item) ?? 0) + 1;
        readsPerItem.set(item, nth);
        if (nth === 2) {
          return new Promise<WhatsappPayload>((resolve) => {
            releaseGet = resolve;
          });
        }
        return Promise.resolve({
          generated: GENERATED,
          saved: { edited: 'mijn tekst', base: GENERATED },
          token: 'tok-1',
          unreadable: false,
          warnings: [],
        });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe('mijn tekst'));

    const discarding = result.current.discard();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });

    // Typed, then undone — same characters, but the planner was working.
    act(() => {
      result.current.setText('mijn tekst!');
    });
    act(() => {
      result.current.setText('mijn tekst');
    });

    await act(async () => {
      releaseGet?.({
        generated: GENERATED,
        saved: { edited: 'mijn tekst', base: GENERATED },
        token: 'tok-2',
        unreadable: false,
        warnings: [],
      });
      await discarding;
      await vi.advanceTimersByTimeAsync(20);
    });

    // Their text stands and is still theirs to save — not silently declared settled.
    expect(result.current.text).toBe('mijn tekst');
    expect(result.current.dirty).toBe(true);
  });
});

describe('an unresolved version question', () => {
  /** Drives the truncated-history path: the write that landed is one we could not keep. */
  const ambiguous = () => {
    let stored: { edited: string; base: string } | null = null;
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: stored,
          token: 'tok-server',
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        if (api.saves.length === MAX_UNCERTAIN_ATTEMPTS + 2) {
          stored = { edited: input.edited, base: input.base };
        }
        return Promise.reject(new Error('verbinding verbroken'));
      },
    });
    return api;
  };

  const reachAmbiguity = async (
    api: ReturnType<typeof ambiguous>,
    result: { current: { setText: (v: string) => void; discard: () => Promise<boolean> } }
  ): Promise<void> => {
    for (let n = 1; n <= MAX_UNCERTAIN_ATTEMPTS + 3; n += 1) {
      act(() => {
        result.current.setText(`D${n}`);
      });
      await settle();
    }
    await act(async () => {
      await result.current.discard();
    });
  };

  /**
   * A conflict notice the next autosave quietly overrides is not a conflict notice. The
   * record's token must not be adopted, and no write may go out until it is resolved.
   */
  it('does not let a later write sail past the record it flagged', async () => {
    const api = ambiguous();
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));
    await reachAmbiguity(api, result);
    expect(result.current.save).toEqual({ kind: 'conflict' });

    const before = api.saves.length;
    act(() => {
      result.current.setText('nog een poging');
    });
    await settle();

    expect(api.saves).toHaveLength(before);
  });

  it('keeps the panel open rather than closing over it', async () => {
    const api = ambiguous();
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));
    await reachAmbiguity(api, result);

    let closed: boolean | null = null;
    await act(async () => {
      closed = await result.current.flush();
    });

    expect(closed).toBe(false);
  });

  it('is resolved by taking the server’s version', async () => {
    const api = ambiguous();
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));
    await reachAmbiguity(api, result);

    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.save).toEqual({ kind: 'idle' });

    // And writing works again afterwards.
    act(() => {
      result.current.setText('verder werken');
    });
    await settle();
    expect(api.saves.at(-1)?.edited).toBe('verder werken');
  });
});

describe('failures that definitely never reached storage', () => {
  /**
   * 401/403/404/400/422 are all refused before a byte is written. Counting them as
   * "might have committed" is false, and repeated oversized saves would burn through the
   * uncertainty bound and raise a version question with nothing at stake.
   */
  it.each([
    ['unauthorized', 401],
    ['wrong board', 403],
    ['oversized', 422],
    ['bad body', 400],
  ])('does not treat a %s refusal as uncertain', async (_label, status) => {
    const api = fakeApi({
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        return Promise.reject(new ApiError(status, 'refused'));
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    for (let n = 1; n <= MAX_UNCERTAIN_ATTEMPTS + 3; n += 1) {
      act(() => {
        result.current.setText(`D${n}`);
      });
      await settle();
    }

    await act(async () => {
      await result.current.discard();
    });

    // No version question — nothing we sent could possibly be stored.
    expect(result.current.save).not.toEqual({ kind: 'conflict' });
  });

  /** A 5xx still counts: the server can fail after the write went through. */
  it('still treats a server error as uncertain', async () => {
    let stored: { edited: string; base: string } | null = null;
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: stored,
          token: 'tok-server',
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        stored = { edited: input.edited, base: input.base };
        return Promise.reject(new ApiError(500, 'internal error'));
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('D1');
    });
    await settle();

    await act(async () => {
      await result.current.discard();
    });

    // Recognised as ours despite the 500, so it is cleaned up rather than preserved.
    expect(api.discards).toHaveLength(1);
  });
});

describe('an attempt that fails while a restore waits for the lock', () => {
  /**
   * D1 is already on the wire when the planner presses Herstel origineel. It commits and
   * loses its reply while the reconciliation is still queued — so it is recorded as
   * possibly-committed AFTER the click. Reading the uncertainty set at click time missed
   * it, and the locked read then preserved our own orphan as a colleague's value.
   */
  it('recognises it as ours', async () => {
    let releaseSave: (() => void) | null = null;
    let stored: { edited: string; base: string } | null = null;
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: stored,
          token: 'tok-read',
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        return new Promise<WhatsappWriteResult>((_resolve, reject) => {
          releaseSave = () => {
            // It lands; the reply never arrives.
            stored = { edited: input.edited, base: input.base };
            reject(new Error('verbinding verbroken'));
          };
        });
      },
    });

    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    act(() => {
      result.current.setText('D1');
    });
    await settle();
    expect(api.saves).toHaveLength(1);

    // Restore is pressed while D1 is still out, then D1 fails behind it.
    const discarding = result.current.discard();
    await act(async () => {
      releaseSave?.();
      await discarding;
      await vi.advanceTimersByTimeAsync(20);
    });

    // D1 was ours, so it is cleaned up rather than left behind as somebody else's.
    expect(api.discards).toHaveLength(1);
    expect(result.current.text).toBe(GENERATED);
  });
});

describe('typing while a version question is open', () => {
  const ambiguousApi = () => {
    let stored: { edited: string; base: string } | null = null;
    const api = fakeApi({
      getWhatsapp: () =>
        Promise.resolve({
          generated: GENERATED,
          saved: stored,
          token: 'tok-server',
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        if (api.saves.length === MAX_UNCERTAIN_ATTEMPTS + 2) {
          stored = { edited: input.edited, base: input.base };
        }
        return Promise.reject(new Error('verbinding verbroken'));
      },
    });
    return api;
  };

  /**
   * Resetting to idle on the first keystroke made the Herladen link vanish while writing
   * stayed blocked — so autosave stopped and Sluiten refused, both with nothing on screen
   * to explain why.
   */
  it('keeps the conflict visible so the way out stays on screen', async () => {
    const api = ambiguousApi();
    const { result } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    for (let n = 1; n <= MAX_UNCERTAIN_ATTEMPTS + 3; n += 1) {
      act(() => {
        result.current.setText(`D${n}`);
      });
      await settle();
    }
    await act(async () => {
      await result.current.discard();
    });
    expect(result.current.save).toEqual({ kind: 'conflict' });

    act(() => {
      result.current.setText('nog wat getypt');
    });

    expect(result.current.save).toEqual({ kind: 'conflict' });

    await settle();
    expect(result.current.save).toEqual({ kind: 'conflict' });
  });
});

describe('returning to a training with an open version question', () => {
  /**
   * The block outlives the failure that produced it. Restoring the generic error offered
   * "Opnieuw proberen" for a write `run` refuses outright, and took the Herladen link —
   * the only way out — off the screen.
   */
  it('still shows the conflict, not a retryable error', async () => {
    let stored: { edited: string; base: string } | null = null;
    const api = fakeApi({
      getWhatsapp: (item: string) =>
        Promise.resolve({
          generated: item === ITEM ? GENERATED : 'BASIS B',
          saved: item === ITEM ? stored : null,
          token: `tok-${item}`,
          unreadable: false,
          warnings: [],
        }),
      saveWhatsapp: (_item, input) => {
        api.saves.push(input);
        if (api.saves.length === MAX_UNCERTAIN_ATTEMPTS + 2) {
          stored = { edited: input.edited, base: input.base };
        }
        return Promise.reject(new Error('verbinding verbroken'));
      },
    });

    const { result, rerender } = open(api);
    await waitFor(() => expect(result.current.text).toBe(GENERATED));

    for (let n = 1; n <= MAX_UNCERTAIN_ATTEMPTS + 3; n += 1) {
      act(() => {
        result.current.setText(`D${n}`);
      });
      await settle();
    }
    await act(async () => {
      await result.current.discard();
    });
    expect(result.current.save).toEqual({ kind: 'conflict' });

    rerender({ id: '999' });
    await waitFor(() => expect(result.current.text).toBe('BASIS B'));
    rerender({ id: ITEM });

    await waitFor(() => expect(result.current.save).toEqual({ kind: 'conflict' }));
  });
});
