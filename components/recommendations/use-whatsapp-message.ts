'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ApiError, type WhatsappApi, type WhatsappPayload } from './api';

/**
 * The WhatsApp message panel's state: load, edit, autosave, reconcile.
 *
 * Most of this file is about partial failure, because that is where an autosaving text
 * box stops being a text box. Four rules carry the weight:
 *
 * 1. **The base travels with the text in the box.** Editing a saved message sends the
 *    base it was saved against — never the freshly generated one — so a stale message
 *    stays flagged however much is typed into it.
 * 2. **The save queue is per training.** One write in flight per item, latest draft
 *    queued behind it. A shared queue would let training A's completion pick up training
 *    B's draft and send it to A.
 * 3. **Nothing is marked clean until the acknowledged text is still the current text.**
 *    An older response landing after a newer keystroke must not make `flush` a no-op.
 * 4. **A discard reconciles before it discards**, and restores the last state the server
 *    actually acknowledged.
 */

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string }
  /** Somebody else wrote. The draft is kept; the planner decides. */
  | { kind: 'conflict' };

export interface WhatsappMessage {
  loading: boolean;
  loadError: string | null;
  /** What is in the textarea. */
  text: string;
  setText: (value: string) => void;
  /** The generated message as of the last load. */
  generated: string;
  warnings: string[];
  /** A saved edit exists and could not be read — clearable via `discard`. */
  unreadable: boolean;
  /** The training changed since this edit was saved. */
  stale: boolean;
  dirty: boolean;
  save: SaveState;
  /** Flush any pending draft; resolves false when the save failed. */
  flush: () => Promise<boolean>;
  /** Reconcile, restore the last acknowledged state, and drop the local draft. */
  discard: () => Promise<boolean>;
  retry: () => Promise<boolean>;
  reload: () => Promise<void>;
}

const DEBOUNCE_MS = 1000;

/**
 * Bounds on the possibly-committed attempts kept per training.
 *
 * Generous, because **no unresolved attempt can be dropped safely.** Oldest-first is
 * wrong under CAS (if the oldest committed, later ones reuse a stale token and are
 * refused, so the oldest is the only candidate). Newest-first is wrong too: the first
 * requests may fail before ever reaching Redis, making a later one the first to actually
 * commit. Either eviction can lose the one attempt that is really on the server.
 *
 * So the list is sized to make eviction essentially unreachable — it takes fifty
 * consecutive transport failures on one training — and when it IS reached the loss is
 * recorded rather than hidden. See {@link Queue.uncertainTruncated}.
 */
export const MAX_UNCERTAIN_ATTEMPTS = 50;

/** A second bound, so fifty long messages cannot sit in memory. */
export const MAX_UNCERTAIN_CHARS = 64 * 1024;

/**
 * Statuses that mean the write definitively never reached storage.
 *
 * Everything the route refuses up front: no token (401), wrong board (403), oversized or
 * malformed body (400/422), missing item (404), and a CAS conflict (409). Recording
 * these as "might have committed" was wrong twice over — it is false, and repeated
 * oversized saves would burn through the uncertainty bound and trip the truncated-history
 * conflict path with nothing actually at stake.
 *
 * Anything else — a network failure, a 5xx, an unrecognised status — stays ambiguous,
 * because a server error can follow a completed write.
 */
const DEFINITELY_NOT_COMMITTED: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 422]);

/** A draft waiting its turn, with the options it needs when it finally goes. */
interface Pending {
  draft: string;
  /** Sticky: once any waiting write needs to outlive the document, the drain does. */
  keepalive: boolean;
}

/**
 * One training's write state. Never shared — see rules 2 and 5.
 *
 * The CAS token and the base live HERE rather than in a component-wide ref, and that is
 * the whole point. With them global, a queued write for training A would drain using
 * training B's token and base after the planner switched — normally a conflict, and
 * silently reported as success because A is no longer the active item.
 */
interface Queue {
  /**
   * Every operation on this training — load, save-drain, discard — chains here.
   *
   * `inFlight` alone was not enough: a discard waited on it but never joined it, so a
   * load could read and clean A's message while the first visit's discard was still
   * about to commit a DELETE behind it.
   */
  lock: Promise<unknown>;
  /** Set while a save drain is queued or running, so further drafts coalesce into it. */
  inFlight: Promise<boolean> | null;
  /**
   * Set while a discard is reconciling.
   *
   * Distinct from `inFlight`, because a flush must react to it differently: a draft
   * queued behind a save is still wanted, whereas a draft queued behind a DISCARD is the
   * very text being thrown away. Enqueueing it would restore the original and then
   * immediately save the discarded draft back over it.
   */
  discarding: Promise<boolean> | null;
  pending: Pending | null;
  token: string;
  base: string;
  saved: { edited: string; base: string } | null;
  /**
   * The editor content for THIS training, and whether it differs from what the server
   * has acknowledged.
   *
   * Component-global versions of these were the last shared-state bug: a departure flush
   * for A, resuming after the planner had switched and typed, read the global draft and
   * wrote B's text to A.
   */
  draft: string;
  dirty: boolean;
  /**
   * A draft whose save did not land, kept so returning to the training does not silently
   * load the old server value over unsaved work. Cleared by the next successful write or
   * a successful restore.
   *
   * It carries the `token` and `base` the attempt was made against, not the ones a later
   * read happens to see. Adopting a fresh revision would let the retry overwrite a
   * colleague who wrote in the meantime, and would rebase the edit so its staleness
   * warning quietly disappeared.
   *
   * `kind` separates a transport failure from a 409. Only the former is worth retrying;
   * a conflict means the server holds something else and the planner has to choose.
   */
  failed: {
    kind: 'error' | 'conflict';
    draft: string;
    base: string;
    token: string;
    message: string;
    /**
     * What the server had acknowledged BEFORE this attempt — where a discard should put
     * things back to.
     *
     * Held here because a later read cannot reconstruct it: if the attempt committed
     * with its response lost, that read returns the attempt itself, and adopting it as
     * the restore point would make "Herstel origineel" delete the draft instead of
     * putting the previous message back.
     */
    restorePoint: { edited: string; base: string } | null;
  } | null;
  /**
   * Attempts that MAY have committed — every transport failure, oldest first.
   *
   * A list, because `failed` holds only the latest and that is not enough: D1 fails in
   * transport (possibly landing), a retry D2 comes back 409, and `failed` now describes
   * D2 alone. A restore could then no longer recognise D1 sitting on the server as ours
   * and would preserve our own orphan as if a colleague had written it.
   *
   * A 409 never joins this list: a refused write definitively did not land.
   */
  uncertain: Array<{ draft: string; base: string }>;
  /**
   * An attempt had to be forgotten, so `uncertain` is no longer a complete record.
   *
   * It changes what an unrecognised server value MEANS. Normally "not one of ours" is
   * good evidence of a colleague's message, and a restore leaves it alone. Once
   * something has been dropped that inference is unsound — the record could be our own
   * orphan — so the planner is asked instead of being told.
   */
  uncertainTruncated: boolean;
  /**
   * No write may go out until the planner resolves which version wins.
   *
   * Set when we cannot tell whether the stored record is ours. A conflict notice that
   * the next autosave quietly overrides is not a conflict notice at all — Herladen is
   * the way out, and it is offered beside the message.
   */
  blocked: boolean;
  /**
   * Counts PLANNER edits, and nothing else.
   *
   * "Did they type during the restore?" was answered by comparing text, which type-then
   * -undo defeats: the strings match, the code concludes nothing happened, and it
   * replaces the planner's latest text with the restored value and calls it clean. A
   * counter cannot be fooled by a round trip back to the same characters.
   */
  editRevision: number;
}

function rememberUncertain(queue: Queue, attempt: { draft: string; base: string }): void {
  const already = queue.uncertain.some(
    (entry) => entry.draft === attempt.draft && entry.base === attempt.base
  );
  /**
   * At the cap we drop the NEWEST, never the oldest.
   *
   * Under CAS the oldest is the one that can actually be on the server: if it committed,
   * the token did not advance for us, so every later attempt reuses a stale token and is
   * refused. Evicting oldest-first — the obvious LRU reflex — throws away the only
   * candidate that matters and lets a restore mistake our own write for a colleague's.
   */
  if (already) {
    return;
  }
  const chars = queue.uncertain.reduce(
    (total, entry) => total + entry.draft.length + entry.base.length,
    attempt.draft.length + attempt.base.length
  );
  if (queue.uncertain.length >= MAX_UNCERTAIN_ATTEMPTS || chars > MAX_UNCERTAIN_CHARS) {
    // Recorded, not silently dropped — see `uncertainTruncated`.
    queue.uncertainTruncated = true;
    return;
  }
  queue.uncertain = [...queue.uncertain, attempt];
}

export function useWhatsappMessage(
  api: WhatsappApi,
  itemId: string | null,
  open: boolean
): WhatsappMessage {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [payload, setPayload] = useState<WhatsappPayload | null>(null);
  /**
   * Read by `push`, which must NOT re-identify itself when the payload changes.
   *
   * `payload` in its dependency array cascaded: new `push` → new `run` → new
   * `flushItem` → the departure effect below re-ran, and its CLEANUP fired mid-session,
   * saving the draft at arbitrary moments and defeating the debounce.
   */
  const payloadRef = useRef<WhatsappPayload | null>(null);
  const [text, setTextState] = useState('');
  const [dirty, setDirty] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });


  const queues = useRef(new Map<string, Queue>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentItem = useRef<string | null>(itemId);
  /** Bumped per load, so a slow failure for a training we left cannot land on this one. */
  const loadSeq = useRef(0);
  /**
   * Bumped on every change of training — including a return to one already visited.
   *
   * Item equality alone has an ABA hole: leave A for B, come back to A, and a discard
   * still running from the FIRST visit sees its item as active again and overwrites
   * whatever has since been loaded or typed. Async work captures the epoch it began in
   * and applies UI state only if both the item and the epoch still match.
   */
  const visit = useRef(0);

  /**
   * Per-training write state, created on demand.
   *
   * `saved` is the last thing the SERVER acknowledged for this training — seeded from
   * its load and advanced on every successful write, including ones that land while the
   * planner is looking at a different training. Not the panel-open snapshot, which is
   * the tempting version and loses data: an autosave can persist intermediate text
   * before a closing save fails, and restoring what was on screen when the panel opened
   * would then destroy a confirmed edit.
   */
  const queueFor = useCallback((item: string): Queue => {
    const existing = queues.current.get(item);
    if (existing !== undefined) {
      return existing;
    }
    const created: Queue = {
      lock: Promise.resolve(),
      inFlight: null,
      discarding: null,
      pending: null,
      token: 'absent',
      base: '',
      saved: null,
      draft: '',
      dirty: false,
      failed: null,
      uncertain: [],
      uncertainTruncated: false,
      blocked: false,
      editRevision: 0,
    };
    queues.current.set(item, created);
    return created;
  }, []);

  /**
   * Run `operation` after everything already queued for this training.
   *
   * Stable across renders — it touches nothing but refs — so the callbacks that depend
   * on it stay memoised and the dependency arrays stay honest.
   */
  const withLock = useCallback(
    <T,>(item: string, operation: () => Promise<T>): Promise<T> => {
      const queue = queueFor(item);
      const result = queue.lock.then(operation, operation);
      queue.lock = result.catch(() => undefined);
      return result;
    },
    [queueFor]
  );

  const clearTimer = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  /**
   * Write to the item's own record, and mirror into React state only when that item is
   * the one on screen. The queue is the source of truth; `text`/`dirty` are the view of
   * whichever training is active.
   */
  const setDraft = useCallback(
    (item: string, value: string, isDirty: boolean): void => {
      const queue = queueFor(item);
      queue.draft = value;
      queue.dirty = isDirty;
      if (currentItem.current === item) {
        setTextState(value);
        setDirty(isDirty);
      }
    },
    [queueFor]
  );

  /**
   * Advance the epoch in the COMMIT phase, before any passive effect.
   *
   * Two wrong answers were tried first. In a passive effect it ran *after* the loader,
   * so every load captured the previous epoch and discarded its own result. During
   * render it was not commit-safe: React can begin rendering B, abandon that render, and
   * leave A committed — but a ref mutation survives the abandonment, so A's still-visible
   * editor would enqueue its text against B. A layout effect runs only on a commit that
   * actually happened, and always before the loader.
   */
  useLayoutEffect(() => {
    currentItem.current = itemId;
    visit.current += 1;
  }, [itemId]);

  const load = useCallback(async (): Promise<void> => {
    const item = itemId;
    if (item === null) {
      return;
    }
    const seq = loadSeq.current + 1;
    loadSeq.current = seq;
    const epoch = visit.current;
    setLoading(true);
    setLoadError(null);
    const queue = queueFor(item);
    try {
      /**
       * Read behind the lock, never beside it.
       *
       * On a quick A → B → A, A's departure save — or a discard from the first visit —
       * can still be outstanding when the second A load fires. A GET that overtook it
       * would return the pre-save snapshot, and applying that regresses this queue's
       * token and marks the stale text clean, after which the write commits behind an
       * editor showing the old value.
       */
      const data = await withLock(item, () => api.getWhatsapp(item));
      // Success, failure AND completion are all guarded. Guarding only the happy path
      // let a slow failure for the previous training write its error over this one's
      // state — and this one's success, having already run, never cleared it.
      if (loadSeq.current !== seq || currentItem.current !== item || visit.current !== epoch) {
        return;
      }
      setPayload(data);
      payloadRef.current = data;
      const pending = queue.failed;
      /**
       * If this read is showing us our OWN uncertain write, the last acknowledged value
       * is still whatever preceded it — not the write itself.
       *
       * Adopting the read value here loses the restore point: server held S, our D
       * committed with its reply lost, the planner returns and presses Herstel
       * origineel, and a discard would delete D rather than putting S back.
       */
      /**
       * Against every outstanding attempt, not just the last one.
       *
       * D1 commits with its reply lost, D2 later fails, the planner leaves and returns:
       * the read can return D1 while `failed` describes D2. Comparing only the latest
       * would adopt D1 as the last acknowledged value, and Herstel origineel would then
       * restore D1 rather than the message that preceded it.
       */
      const readValue = data.saved;
      const readIsOurAttempt =
        readValue !== null &&
        (queue.uncertain.some(
          (attempt) => attempt.draft === readValue.edited && attempt.base === readValue.base
        ) ||
          (pending !== null &&
            readValue.edited === pending.draft &&
            readValue.base === pending.base));
      queue.saved = readIsOurAttempt ? (pending?.restorePoint ?? null) : data.saved;
      queue.token = data.token;
      queue.base = data.saved?.base ?? data.generated;
      /**
       * An unsaved draft whose save failed outranks the server's value.
       *
       * Otherwise a departure save that rejected after the planner had already moved on
       * would be forgotten, and returning to the training would quietly load the old
       * message over work that was never stored.
       */
      const unsaved = pending;
      if (unsaved !== null) {
        /**
         * Restore the attempt's OWN revision, not the one we just read.
         *
         * Adopting the fresh token would let a retry overwrite a colleague who wrote
         * while the planner was away — the CAS would match, so there would be no
         * conflict to notice. Adopting the fresh base would rebase the edit and make its
         * staleness warning disappear on its own.
         */
        queue.token = unsaved.token;
        queue.base = unsaved.base;
        // Anything typed after the failure is newer than the failed attempt and wins.
        const typedSince = queue.dirty && queue.draft !== unsaved.draft;
        setDraft(item, typedSince ? queue.draft : unsaved.draft, true);
        /**
         * Blocked wins.
         *
         * An unresolved version question outlives the failure that produced it, so
         * restoring the generic error here offered "Opnieuw proberen" for a write that
         * `run` refuses outright — and took the Herladen link, the only way out, off the
         * screen.
         */
        setSave(
          queue.blocked || unsaved.kind === 'conflict'
            ? { kind: 'conflict' }
            : { kind: 'error', message: unsaved.message }
        );
      } else {
        setDraft(item, data.saved?.edited ?? data.generated, false);
        setSave({ kind: 'idle' });
      }
    } catch (cause) {
      if (loadSeq.current !== seq || currentItem.current !== item || visit.current !== epoch) {
        return;
      }
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (loadSeq.current === seq) {
        setLoading(false);
      }
    }
  }, [api, itemId, queueFor, setDraft, withLock]);

  /**
   * Send one draft for one training.
   *
   * `item` is a parameter rather than a closure over `itemId` so a queue draining after
   * the planner has moved on still writes to the training the draft belongs to.
   */
  const push = useCallback(
    async (item: string, draft: string, options: { keepalive?: boolean } = {}): Promise<boolean> => {
      const queue = queueFor(item);
      const epoch = visit.current;
      const active = (): boolean => currentItem.current === item && visit.current === epoch;
      // The revision this attempt is made against, kept so a failure can be retried
      // against the same one rather than against whatever a later read returns.
      const attemptToken = queue.token;
      const attemptBase = queue.base;
      const attemptRestorePoint = queue.saved;
      if (active()) {
        setSave({ kind: 'saving' });
      }
      try {
        const result =
          draft.trim() === ''
            ? await api.discardWhatsapp(item, queue.token, options)
            : await api.saveWhatsapp(
                item,
                { edited: draft, base: queue.base, token: queue.token },
                options
              );

        /**
         * Advance the token FIRST, and unconditionally.
         *
         * Returning early because the planner has moved on was the bug: this training's
         * queued write would then still hold the pre-write token and conflict — a
         * conflict nobody sees, because the UI belongs to another training now.
         */
        queue.saved = result.saved;
        queue.token = result.token;
        /**
         * The QUEUE is reconciled unconditionally; only the React writes are gated.
         *
         * Clearing these behind the active check meant a retry that succeeded after the
         * planner switched away left the failure recorded — so returning reported an
         * error for text the server had already acknowledged.
         */
        queue.failed = null;
        // Anything that might have been outstanding is now definitively superseded.
        queue.uncertain = [];
        queue.uncertainTruncated = false;
        queue.blocked = false;
        const stillMine = queue.draft === draft;
        const newer = queue.pending !== null && queue.pending.draft !== draft;
        if (stillMine && !newer) {
          queue.dirty = false;
        }

        if (!active()) {
          return true;
        }
        setSave({ kind: 'saved' });

        /**
         * Only now is it safe to call this clean, and only if something NEWER exists.
         *
         * Clearing unconditionally is the subtle data-loss bug: an older response
         * landing after a newer keystroke would mark the box clean, and a subsequent
         * `flush` — on close — would see nothing to do and drop the newer text. An
         * identical queued draft is not newer, though: the drain discards it without
         * another pass, so treating it as work would leave the box dirty forever.
         */
        if (stillMine && !newer) {
          setDraft(item, draft, false);
        }

        // Whatever was unreadable has just been overwritten by something we wrote, so
        // the corruption notice has to go — leaving it up outlived the problem, and the
        // planner had no way to tell the difference.
        setPayload((previous) => {
          const next =
            previous === null || !previous.unreadable ? previous : { ...previous, unreadable: false };
          payloadRef.current = next;
          return next;
        });

        // An emptied box deletes the record, so the editor must return to the generated
        // message AND adopt its base. Leaving the old base behind would save the next
        // edit against a message that is no longer there, and keep a false stale warning.
        if (draft.trim() === '' && result.saved === null) {
          const fresh = payloadRef.current?.generated ?? '';
          queue.base = fresh;
          if (queue.draft === draft) {
            setDraft(item, fresh, false);
          }
        }
        return true;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const conflicted = cause instanceof ApiError && cause.status === 409;
        /**
         * Kept on the ITEM, so it survives the planner switching away and coming back —
         * and tagged, because a conflict is not unsaved work to retry. Recording one as
         * a plain failure turned "Herladen" into "keep my text and overwrite theirs".
         */
        queue.failed = {
          kind: conflicted ? 'conflict' : 'error',
          draft,
          base: attemptBase,
          token: attemptToken,
          message,
          // The first failure's restore point is the true one: a later retry's
          // "previous" is whatever the earlier attempt may already have written.
          restorePoint: queue.failed?.restorePoint ?? attemptRestorePoint,
        };
        const definitelyNotCommitted =
          cause instanceof ApiError && DEFINITELY_NOT_COMMITTED.has(cause.status);
        if (!definitelyNotCommitted) {
          rememberUncertain(queue, { draft, base: attemptBase });
        }
        if (!active()) {
          return true;
        }
        setSave(conflicted ? { kind: 'conflict' } : { kind: 'error', message });
        return false;
      }
    },
    [api, queueFor, setDraft]
  );

  /** Rule 2: one at a time PER TRAINING, latest draft queued behind. */
  const run = useCallback(
    (item: string, draft: string, options: { keepalive?: boolean } = {}): Promise<boolean> => {
      const queue = queueFor(item);
      /**
       * Nothing goes out while the version question is open.
       *
       * The debounce, the close-flush and a manual retry all come through here, and any
       * of them would resolve the conflict by force. Herladen clears the block.
       */
      if (queue.blocked) {
        return Promise.resolve(false);
      }
      if (queue.inFlight !== null) {
        // Sticky keepalive: a lifecycle flush queued behind an ordinary save must not
        // lose the one property that lets it survive the document going away.
        queue.pending = {
          draft,
          keepalive: (queue.pending?.keepalive ?? false) || options.keepalive === true,
        };
        return queue.inFlight;
      }
      // Iterative rather than recursive, so the queue drains without `run` referring to
      // itself through a closure that may already be stale.
      const drain = async (): Promise<boolean> => {
        let current = draft;
        let currentOptions = options;
        let okay = true;
        for (;;) {
          okay = await push(item, current, currentOptions);
          const next = queue.pending;
          queue.pending = null;
          if (!okay || next === null || next.draft === current) {
            break;
          }
          current = next.draft;
          currentOptions = { keepalive: next.keepalive };
        }
        queue.inFlight = null;
        return okay;
      };
      const attempt = withLock(item, drain);
      queue.inFlight = attempt;
      return attempt;
    },
    [push, queueFor, withLock]
  );

  const setText = useCallback(
    (value: string): void => {
      const item = currentItem.current;
      if (item === null) {
        return;
      }
      const queue = queueFor(item);
      queue.editRevision += 1;
      setDraft(item, value, true);
      /**
       * Typing clears a stale save message — but NOT an unresolved version question.
       *
       * While blocked, the scheduled save exits early without restoring anything, so
       * resetting to idle here made the Herladen link vanish, autosave stop silently,
       * and Sluiten refuse for no visible reason.
       */
      if (!queue.blocked) {
        setSave({ kind: 'idle' });
      }
      clearTimer();
      timer.current = setTimeout(() => {
        if (item !== null) {
          void run(item, value);
        }
      }, DEBOUNCE_MS);
    },
    [run, setDraft, queueFor]
  );

  const flushItem = useCallback(
    async (item: string, options: { keepalive?: boolean } = {}): Promise<boolean> => {
      clearTimer();
      const queue = queueFor(item);

      /**
       * Let a discard finish, then look again.
       *
       * Press Herstel origineel and then Sluiten before reconciliation lands, and the
       * old behaviour queued the pre-discard text behind it: the discard restored the
       * original, the queued PUT wrote the discarded draft straight back, and the panel
       * closed reporting success. After the discard settles the editor holds the
       * restored text and is clean, so there is nothing left to flush.
       */
      if (queue.discarding !== null) {
        /**
         * A restore that failed stops the close.
         *
         * Ignoring its result meant pressing Herstel origineel and then Sluiten, with
         * the reconciling read failing, would fall through to saving the still-dirty
         * draft and report success — closing the panel over a restore that never
         * happened, and writing back the text it was meant to remove.
         */
        const restored = await queue.discarding.catch(() => false);
        if (!restored) {
          return false;
        }
      }
      if (!queue.dirty && queue.inFlight === null) {
        return true;
      }
      // `queue.draft`, never the on-screen text: after the await the planner may be on
      // another training, and this flush belongs to `item`.
      return await run(item, queue.draft, options);
    },
    [run, queueFor]
  );

  const flush = useCallback((): Promise<boolean> => {
    const item = currentItem.current;
    return item === null ? Promise.resolve(true) : flushItem(item);
  }, [flushItem]);

  /**
   * The lifecycle effects below must fire on a change of TRAINING and nothing else, so
   * they reach the current flush through a ref rather than depending on its identity.
   */
  const flushItemRef = useRef(flushItem);
  useEffect(() => {
    flushItemRef.current = flushItem;
  }, [flushItem]);

  /**
   * Leaving a training saves its draft first.
   *
   * In the cleanup, so it runs BEFORE the next item's effects — and so it covers unmount
   * too. Without it, switching item inside the debounce window silently discarded
   * whatever had just been typed.
   */
  useEffect(() => {
    const item = itemId;
    return () => {
      clearTimer();
      if (item !== null && queueFor(item).dirty) {
        void flushItemRef.current(item, { keepalive: true });
      }
    };
  }, [itemId, queueFor]);

  useEffect(() => {
    if (!open || itemId === null) {
      return;
    }
    void load();
  }, [open, itemId, load]);

  /**
   * A different training is a different message. Drop the visible state — the draft
   * itself has already been flushed by the cleanup above.
   */
  useEffect(() => {
    setPayload(null);
    const queue = itemId === null ? null : queueFor(itemId);
    setTextState(queue?.draft ?? '');
    setDirty(queue?.dirty ?? false);
    setSave(
      queue?.blocked === true
        ? { kind: 'conflict' }
        : queue?.failed !== null && queue?.failed !== undefined
          ? { kind: 'error', message: queue.failed.message }
          : { kind: 'idle' }
    );
  }, [itemId, queueFor]);

  /**
   * Best-effort save when the iframe goes away.
   *
   * `keepalive` lets the request outlive the document, which is the only reason this has
   * any chance at all — but it is not a guarantee: the flush first awaits a fresh session
   * token and may retry a 401, and Monday can suspend the frame before either finishes.
   * The real protections are the one-second debounce and a close that waits.
   */
  useEffect(() => {
    const onHidden = (): void => {
      const item = currentItem.current;
      if (document.visibilityState === 'hidden' && item !== null && queueFor(item).dirty) {
        void flushItemRef.current(item, { keepalive: true });
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [queueFor]);

  /**
   * Reconcile, then restore.
   *
   * A network error can land after Redis committed, so dropping local state could leave
   * the "discarded" draft saved. But deleting whatever is found is equally wrong: if the
   * server held a message before this edit, discarding must put THAT back, not wipe the
   * training's message.
   */
  /**
   * Reconcile, then restore. Runs under the training's lock.
   *
   * A network error can land after Redis committed, so dropping local state could leave
   * the "discarded" draft saved. But deleting whatever is found is equally wrong: if the
   * server held a message before this edit, discarding must put THAT back, not wipe the
   * training's message.
   */
  const reconcile = useCallback(
    async (
      item: string,
      context: {
        mine: string;
        myBase: string;
        previous: { edited: string; base: string } | null;
        editRevision: number;
        active: () => boolean;
      }
    ): Promise<boolean> => {
      const { mine, myBase, previous, editRevision, active } = context;
      const queue = queueFor(item);
      // The revision the on-screen draft belongs to, before this reconciliation moves it.
      const priorToken = queue.token;
      const priorBase = queue.base;
      /**
       * Read HERE, inside the lock — not snapshotted when the planner clicked.
       *
       * A write already on the wire can fail, and be recorded as possibly-committed,
       * while this reconciliation waits its turn. A snapshot taken before the wait would
       * miss it, and the read below would then find our own orphan and preserve it as a
       * colleague's. `mine`, `previous` and `editRevision` still come from the click,
       * because those describe what the planner asked for.
       */
      const uncertain = queue.uncertain;
      const truncated = queue.uncertainTruncated;
      const current = await api.getWhatsapp(item);

      // Both halves, or a colleague's identical-looking message gets discarded as ours.
      const ours = (edited: string, base: string): boolean =>
        current.saved?.edited === edited && current.saved?.base === base;
      /**
       * EVERY attempt that may have committed counts as ours, not just the last one.
       *
       * D1 commits with its response lost, the planner types D2 and then restores: the
       * read returns D1, which is not the text on screen. Comparing only against the
       * textarea — or only against the most recent failure — would call that a
       * colleague's version and leave it in place: our own orphaned write, kept forever.
       */
      const isOurDraft =
        ours(mine, myBase) || uncertain.some((attempt) => ours(attempt.draft, attempt.base));

      /**
       * We cannot prove it is NOT ours.
       *
       * With a complete record, "not one of ours" is good evidence of a colleague's
       * message and leaving it alone is right. Once an attempt has been forgotten that
       * inference is unsound, and silently preserving what may be our own orphan is the
       * failure this whole apparatus exists to avoid. So the planner is asked.
       */
      if (!isOurDraft && truncated && current.saved !== null) {
        /**
         * Flagged as a conflict, so its revision is emphatically NOT ours to take.
         *
         * Adopting `current.token` here would let the next keystroke — or the save on
         * close — sail through the CAS and overwrite the very record we are presenting
         * as unresolved. The draft keeps the revision it was written against, and
         * writing is blocked until the planner says which version wins.
         */
        queue.token = priorToken;
        queue.base = priorBase;
        queue.blocked = true;
        if (active()) {
          setSave({ kind: 'conflict' });
        }
        return true;
      }
      /**
       * A record we cannot parse is still a record, and `Herstel origineel` is the only
       * way to be rid of it. The API reports it as `saved: null` plus a warning and a
       * usable token — treating that as "nothing stored" left the corrupt value, and its
       * warning, in place forever.
       */
      const isUnreadable = current.unreadable;

      let adoptedForeign = false;
      if (isOurDraft && previous !== null && previous.edited !== mine) {
        // Put back the last thing the server acknowledged before this edit.
        const restored = await api.saveWhatsapp(item, { ...previous, token: current.token });
        queue.saved = restored.saved;
        queue.token = restored.token;
      } else if (isOurDraft || isUnreadable) {
        const gone = await api.discardWhatsapp(item, current.token);
        queue.saved = null;
        queue.token = gone.token;
      } else {
        // A colleague's version is there, or nothing is. Either way it is not ours to
        // remove — drop only the local draft.
        adoptedForeign = true;
        queue.saved = current.saved;
        queue.token = current.token;
      }

      const settled = queue.saved;
      queue.base = settled?.base ?? current.generated;

      /**
       * Typing during a restore must not inherit a colleague's revision.
       *
       * When the read found somebody else's message we adopt their token so the editor
       * reflects reality — but if the planner typed while we were waiting, that new text
       * would then save against THEIR token and overwrite them with no 409 at all. Its
       * own revision is kept instead, so the CAS still gets to refuse.
       *
       * Scoped to that branch alone. Clearing a corrupt record also leaves `isOurDraft`
       * false, but there we just wrote the tombstone ourselves — reverting to the old
       * token would make the queued edit conflict with a record nobody else touched.
       */
      // By revision, not by text: typing a character and undoing it is still typing.
      const typedDuringRestore = queue.editRevision !== editRevision;
      if (adoptedForeign && typedDuringRestore) {
        queue.token = priorToken;
        queue.base = priorBase;
      }

      /**
       * The queue settles whether or not this training is still on screen.
       *
       * Leaving `draft`/`dirty` behind the active check was a way to undo a restore: edit
       * A, start restoring it, switch to B, and A's departure flush would wait for the
       * restore and then save the obsolete dirty draft straight back over it. `setDraft`
       * already mirrors into React state only when the item is active, so this is safe
       * to do unconditionally.
       */
      if (typedDuringRestore) {
        // The planner typed during the restore; their text stands and is still unsaved.
        queue.dirty = true;
      } else {
        setDraft(item, settled?.edited ?? current.generated, false);
      }
      /**
       * The retained failure is obsolete once this settles: whatever it described has
       * either been restored or removed. Leaving it meant a later `load` resurrected the
       * discarded edit, and its error with it.
       */
      queue.failed = null;
      queue.uncertain = [];
      queue.uncertainTruncated = false;
      queue.blocked = false;
      if (!active()) {
        return true;
      }
      // `unreadable` is a flag, not a sentence — clearing it leaves the drift, missing
      // -column and truncation warnings exactly where they were.
      payloadRef.current = { ...current, unreadable: false };
      setPayload(payloadRef.current);

      /**
       * The editor is declared settled only if the planner has not typed since the
       * discard began. The textarea stays writable throughout reconciliation, so
       * otherwise the settled value would overwrite the new text and mark it clean —
       * after which its debounce would save text nobody could see.
       */
      if (!typedDuringRestore) {
        setSave({ kind: 'idle' });
      }
      return true;
    },
    [api, queueFor, setDraft]
  );

  const discard = useCallback(async (): Promise<boolean> => {
    const item = currentItem.current;
    if (item === null) {
      return true;
    }
    clearTimer();
    const queue = queueFor(item);
    queue.pending = null;

    /**
     * Everything this decision rests on is captured BEFORE the first await, and every
     * UI write after one is gated on still being on `item` in the same visit.
     *
     * Both halves matter. Read `latestText` after the await and a planner who switched
     * training would have B's draft compared against A's server state; write the result
     * back unconditionally and A's response would land in B's textarea. The server-side
     * reconciliation still completes either way — restoring A's message is correct
     * regardless of what the planner is looking at now.
     */
    const mine = queue.draft;
    const previous = queue.saved;
    const editRevision = queue.editRevision;
    /**
     * The base we would have written this draft against. Needed to RECOGNISE the draft:
     * `edited` alone does not identify it, so a colleague who saved the same visible
     * text against a newer generated base would be mistaken for us — and deleted.
     */
    const myBase = queue.base;
    const epoch = visit.current;
    const active = (): boolean => currentItem.current === item && visit.current === epoch;

    if (active()) {
      setSave({ kind: 'saving' });
    }
    try {
      /**
       * The WHOLE reconciliation runs under the lock — read, decide, write.
       *
       * Waiting on an in-flight save without joining the queue was not enough: a load
       * arriving mid-reconciliation could read and clean the old message, and the DELETE
       * would land behind it. Racing the other way loses too, with a GET overtaking a
       * pending write, restoring a pre-write value, and letting the PUT commit after we
       * told the planner the draft was gone.
       */
      const reconciling = withLock(item, () =>
        reconcile(item, { mine, myBase, previous, editRevision, active })
      );
      // Published BEFORE the await, so a close arriving mid-reconciliation can see it
      // and wait rather than queueing the text being discarded.
      queue.discarding = reconciling;
      try {
        return await reconciling;
      } finally {
        if (queue.discarding === reconciling) {
          queue.discarding = null;
        }
      }
    } catch (cause) {
      if (!active()) {
        return false;
      }
      // We do not know what the server holds, so we do not claim to have discarded it.
      setSave({
        kind: 'error',
        message:
          cause instanceof Error
            ? `niet gecontroleerd: ${cause.message}`
            : 'het bericht kon niet worden gecontroleerd',
      });
      return false;
    }
  }, [queueFor, reconcile, withLock]);

  /**
   * Herladen — take the server's version, dropping ours.
   *
   * It has to discard the retained failure first, or `load` would dutifully restore the
   * very draft the planner just asked to abandon. This is the one action that means
   * "theirs wins".
   */
  const reload = useCallback(async (): Promise<void> => {
    const item = currentItem.current;
    if (item !== null) {
      const queue = queueFor(item);
      queue.failed = null;
      queue.uncertain = [];
      queue.uncertainTruncated = false;
      queue.blocked = false;
      queue.dirty = false;
    }
    await load();
  }, [load, queueFor]);

  const retry = useCallback((): Promise<boolean> => {
    const item = currentItem.current;
    return item === null ? Promise.resolve(true) : run(item, queueFor(item).draft);
  }, [run, queueFor]);

  useEffect(() => clearTimer, []);

  const generated = payload?.generated ?? '';
  /**
   * The base of the text ON SCREEN, not of whatever the server last returned.
   *
   * Those differ exactly when it matters: with a retained failure, `saved` describes the
   * freshly read server value while the textarea still holds the local attempt. Reading
   * the former reported "not stale" for a draft written against an older message.
   */
  const displayedBase = itemId === null ? null : (queues.current.get(itemId)?.base ?? null);

  return {
    loading,
    loadError,
    text,
    setText,
    generated,
    warnings: payload?.warnings ?? [],
    unreadable: payload?.unreadable ?? false,
    // The training moved on since this edit was saved against it.
    stale:
      displayedBase !== null &&
      displayedBase !== '' &&
      generated !== '' &&
      displayedBase !== generated,
    dirty,
    save,
    flush,
    discard,
    retry,
    reload,
  };
}
