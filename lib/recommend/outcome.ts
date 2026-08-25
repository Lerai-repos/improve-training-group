import { z } from 'zod';

import type { Redis } from '@upstash/redis';

import { isStatusLabel, type StatusLabel } from './delivery';
import { ttlStateFromPttl, type KvStore, type TtlState } from './kv';
import { storedRowSchema, type StoredRow } from './view-row';

import type { SettingsProvenance } from '@lib/settings';

/**
 * The immutable outcome of one (training, generation), in two keys.
 *
 * Compute is not idempotent — it reads live Monday data and calls paid providers, so
 * running it twice for the same generation can legitimately produce two different
 * answers. Every redelivery path (a QStash retry, a repair hop, a DLQ replay, the
 * failure callback) therefore reads the recorded outcome instead of recomputing, and
 * the FIRST writer wins.
 *
 * ## Why the label and the detail are separate keys
 *
 * The LABEL carries no expiry, exactly as before. `/api/cron/publish-pending` retries a
 * stuck trigger forever on purpose (`docs/m2b/README.md` §3 — an attempt cap "would make
 * a long QStash outage unrecoverable"), so the replay horizon is unbounded; it is not
 * QStash's DLQ retention. A label that could lapse would let a recovered repair recompute
 * a generation that has already been answered and delivered.
 *
 * The DETAIL — the ranked rows a planner looks at — is performance and remuneration data
 * about identifiable trainers, and keeping that forever should be a decision rather than
 * a side effect of the above. It expires after twelve months.
 *
 * They are written by ONE operation. Two calls could crash in between, and `job.ts`
 * short-circuits on the label, so a retry would never run again to repair the missing
 * rows — the list would be lost for good while the board still showed an answer.
 *
 * ## The watermark
 *
 * `completed-gen:<item>` is the highest generation that ever produced a label. Once the
 * detail expires, "generation exists, no rows" is otherwise indistinguishable from "still
 * computing", and a year-old training would spin forever. One integer per training, so
 * unlike a per-generation marker it cannot grow without bound.
 *
 * ## Legacy values
 *
 * Records written before this change are bare label strings under the SAME key, so every
 * delivery path keeps reading exactly what it read before. They simply have no detail,
 * which the API reports as `unavailable` — offering a recalculate rather than a spinner.
 */

const labelKey = (mondayItemId: string, generation: number): string =>
  `result:${mondayItemId}:${generation}`;
const rowsKey = (mondayItemId: string, generation: number): string =>
  `rows:${mondayItemId}:${generation}`;
const watermarkKey = (mondayItemId: string): string => `completed-gen:${mondayItemId}`;

/** Twelve months — 4× the longest QStash DLQ retention tier, and a bounded lifetime
 *  for trainer performance data. Changing it means re-checking both. */
export const ROWS_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * A discriminated union, not one object with nullable everything.
 *
 * The three kinds are mutually exclusive by construction — `ready` HAS rows and no
 * failure, `failed` has a failure and no rows — and a flat schema would happily accept
 * `{ kind: 'ready', rows: null }`, which every reader would then have to defend against
 * at the point of use. Validating the combination here is the only place it can be done
 * once. `rows` and `failure` stay present-but-null in the other branches so callers can
 * read `detail.rows` without narrowing first.
 */
const failureSchema = z.object({ stage: z.string().min(1), message: z.string().nullable() });

/**
 * Which settings produced this outcome.
 *
 * ## Why the record is VERSIONED rather than extended
 *
 * `ROWS_TTL_MS` is a year, so every detail written before today is still being read.
 * Making these fields required would have failed Zod on **every existing record** the
 * moment this deployed, and each one would show as unavailable. So `v: 2` is written
 * going forward while `v: 1` keeps decoding, with `settings: null`.
 *
 * ## Why `failed` may carry null even at v2
 *
 * The settings read is one of the things that can fail — and when it does, no snapshot
 * ever existed. Yet after QStash exhausts its retries `failure-callback.ts` still has to
 * claim `dlq_exhausted`, or the board sits on `computing` for ever. Requiring provenance
 * on every v2 outcome would make the terminal FOUT unrecordable for precisely the
 * failure this design exists to surface.
 *
 * `ready` and `no_match` cannot be *constructed* without it — see {@link OutcomeClaim} —
 * so the looseness here is only what reading old records requires.
 */
const provenanceSchema = z.object({
  boardId: z.string().min(1),
  readAt: z.number(),
  fingerprint: z.string().min(1),
});

/** v1 has no provenance; v2 does. Both stay readable. */
const versionSchema = z.union([z.literal(1), z.literal(2)]);
const settingsField = provenanceSchema.nullable().default(null);

/**
 * v2 must MEAN something, or the version is decoration.
 *
 * A nullable field alone lets `{v: 2, kind: 'ready'}` with no settings decode happily
 * as `settings: null` — which is indistinguishable from a v1 record and quietly hides a
 * malformed write, on the very field the audit trail depends on.
 *
 * The exemption is narrower than "any failure". A `travel` or `load_training` failure
 * happened INSIDE a run, which by definition had a snapshot, so omitting provenance
 * there is a bug rather than a fact about the world. Only {@link PRE_COMPUTE_STAGE} can
 * legitimately have none: it is claimed by the failure callback after QStash gave up,
 * when compute never ran and the settings read may be precisely what failed.
 */
const PRE_COMPUTE_STAGE = 'dlq_exhausted';

function requireProvenanceAtV2(
  detail: { v: 1 | 2; kind: string; settings: unknown; failure: { stage: string } | null },
  ctx: z.RefinementCtx
): void {
  if (detail.v !== 2 || detail.settings !== null) {
    return;
  }
  if (detail.kind === 'failed' && detail.failure?.stage === PRE_COMPUTE_STAGE) {
    return;
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['settings'],
    message:
      `a v2 '${detail.kind}' outcome must record which settings produced it ` +
      `(only a '${PRE_COMPUTE_STAGE}' failure may have none)`,
  });
}

const storedRowsSchema = z.discriminatedUnion('kind', [
  z.object({
    v: versionSchema,
    settings: settingsField,
    kind: z.literal('ready'),
    /** The training's own month, for read-time workload counts. Absent on older rows. */
    trainingMonth: z.string().nullable().default(null),
    /**
     * The training's duration in hours, shown above the list beside "Duur facturatie".
     *
     * A property of the TRAINING, so it belongs here rather than repeated down every
     * row. Nullable for the same reason `trainingMonth` is: the board's `duur` column can
     * be empty, and rows written before this field existed have no value for it — the
     * header renders nothing rather than a misleading `0,00`.
     */
    duurTraining: z.number().finite().nonnegative().nullable().default(null),
    /**
     * `'city'` when these distances were measured to a town centre because Locatie named
     * only a town, otherwise null.
     *
     * Recorded with the list rather than resolved at read time: it describes how the
     * kilometres stored in these rows were obtained, and someone typing a full address
     * tomorrow does not make yesterday's numbers exact. `.default(null)` so every list
     * written before this existed reads as "no warning", which is what it was.
     */
    travelPrecision: z.literal('city').nullable().default(null),
    // At least one. `service.ts` emits GEREED exactly when `ranked.length > 0` and
    // GEEN MATCH otherwise, so a ready-but-empty artifact contradicts the label it was
    // stored beside, and the view would render it as a successful empty recommendation.
    rows: z.array(storedRowSchema).min(1),
    failure: z.null(),
  }),
  z.object({
    v: versionSchema,
    settings: settingsField,
    kind: z.literal('no_match'),
    // "We looked and found nobody" — an empty list is the whole content of the answer.
    rows: z.array(storedRowSchema).max(0),
    failure: z.null(),
  }),
  z.object({
    v: versionSchema,
    settings: settingsField,
    kind: z.literal('failed'),
    rows: z.null(),
    failure: failureSchema,
  }),
]).superRefine(requireProvenanceAtV2);

/** The detail behind a label: the rows a planner sees, or why there are none. */
export type StoredDetail = z.infer<typeof storedRowsSchema>;

/**
 * What one execution wants to record. The label is derived, never passed separately.
 *
 * Note the asymmetry in `settings`, which is the whole v2 contract expressed in the
 * type: a run that produced an answer **must** say which settings produced it, while a
 * failure may legitimately have none — a settings read that never succeeded has no
 * snapshot to name, and that is exactly when `dlq_exhausted` has to be recordable.
 */
export type OutcomeClaim =
  | {
      kind: 'ready';
      rows: StoredRow[];
      trainingMonth: string | null;
      duurTraining: number | null;
      travelPrecision: 'city' | null;
      settings: SettingsProvenance;
    }
  | { kind: 'no_match'; settings: SettingsProvenance }
  | {
      kind: 'failed';
      stage: string;
      message: string | null;
      settings: SettingsProvenance | null;
    };

export function claimLabel(claim: OutcomeClaim): StatusLabel {
  if (claim.kind === 'ready') {
    return 'GEREED';
  }
  return claim.kind === 'no_match' ? 'GEEN MATCH' : 'FOUT';
}

/**
 * The detail, encoded — or a refusal, before anything has been written.
 *
 * The label is permanent and `runJob` short-circuits on it, so an invalid detail is not
 * a bad record that a later attempt repairs: the very next retry sees the label, skips
 * compute, and the rows are gone for good while the board reads GEREED. A type
 * annotation cannot prevent that — `detailOf` returning `StoredDetail` says nothing
 * about a `NaN` fee or an empty failure stage arriving at runtime. So the same schema
 * that guards reads guards writes, and it runs BEFORE the first key is touched.
 */
function encodeDetail(claim: OutcomeClaim): string {
  const parsed = storedRowsSchema.safeParse(detailOf(claim));
  if (!parsed.success) {
    const why = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Refusing to claim an invalid outcome: ${why}`);
  }
  return JSON.stringify(parsed.data);
}

function detailOf(claim: OutcomeClaim): StoredDetail {
  if (claim.kind === 'ready') {
    return {
      v: 2,
      settings: claim.settings,
      kind: 'ready',
      rows: claim.rows,
      trainingMonth: claim.trainingMonth,
      duurTraining: claim.duurTraining,
      travelPrecision: claim.travelPrecision,
      failure: null,
    };
  }
  if (claim.kind === 'no_match') {
    return { v: 2, settings: claim.settings, kind: 'no_match', rows: [], failure: null };
  }
  return {
    v: 2,
    settings: claim.settings,
    kind: 'failed',
    rows: null,
    failure: { stage: claim.stage, message: claim.message },
  };
}

export interface OutcomeStore {
  /**
   * Record this execution's outcome, or discover the one that got there first.
   * Returns the AUTHORITATIVE label — deliver that, never the caller's own.
   */
  claim(mondayItemId: string, generation: number, claim: OutcomeClaim): Promise<StatusLabel>;
  /** The label alone. Unchanged shape and semantics, including for legacy values. */
  read(mondayItemId: string, generation: number): Promise<StatusLabel | null>;
  /** The rows, or null when they have expired or were never written (legacy). */
  readDetail(mondayItemId: string, generation: number): Promise<StoredDetail | null>;
  /**
   * How much longer the rows will live.
   *
   * The `Benaderd` marks annotate a specific stored list, so they are written with
   * whatever is LEFT of that list's lifetime — not a fresh twelve months. Otherwise a
   * mark ticked in month eleven would outlive the rows by nearly a year and reappear
   * against a later generation's list.
   */
  readRowsTtl(mondayItemId: string, generation: number): Promise<TtlState>;
  /** Highest generation that ever produced a label; 0 when none has. */
  readCompletedGeneration(mondayItemId: string): Promise<number>;
}

/**
 * The watermark, or a loud failure — never `NaN`.
 *
 * `Number('abc')` is `NaN`, and `NaN` compares false BOTH ways: the state resolver asks
 * `watermark < generation` to mean "still computing" and `>= generation` to mean
 * "expired", so a `NaN` would answer *neither* and fall through to whichever branch
 * happened to be last. That is the failure mode this store exists to prevent, and it
 * would be indistinguishable from a legitimate answer.
 *
 * Corruption is not recoverable here and must not be guessed at: 0 would claim nothing
 * has ever completed for a training that has, resurrecting the permanent spinner. The
 * write path already behaves this way — `tonumber()` on a malformed value returns nil
 * and the Lua comparison errors — so both sides of the key fail loudly and alike. We are
 * the only writer, and we only ever write `String(generation)`.
 */
function parseWatermark(raw: string | number | null | undefined, mondayItemId: string): number {
  if (raw === null || raw === undefined) {
    return 0;
  }
  // `Number('')` is 0, so a blank would masquerade as "never completed" — the exact
  // wrong answer — rather than as the corruption it is.
  const blank = typeof raw === 'string' && raw.trim() === '';
  const value = Number(raw);
  if (blank || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Corrupt completed-generation watermark for item ${mondayItemId}: ${JSON.stringify(raw)}`
    );
  }
  return value;
}

/** Unreadable detail is treated as absent — `unavailable` beats rendering nonsense. */
function parseDetail(raw: string | null): StoredDetail | null {
  if (raw === null) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = storedRowsSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/**
 * Store over a plain {@link KvStore}: the same rules as the Lua below, expressed as
 * separate writes. Production uses {@link createUpstashOutcomeStore}; this one backs the
 * in-memory tests, and is kept alongside so the two sets of rules are read together.
 * Same split as `queue-store.ts`.
 *
 * Every operation is serialized per training. Being in one process is not the same as
 * being atomic: `readCompletedGeneration` then `set` is a read-modify-write across two
 * awaits, so two concurrent claims for generations 5 and 2 can both observe 0 and the
 * later write — 2 — wins, moving the watermark BACKWARDS. Lua cannot do that (one
 * script, one thread), and a twin that can is worse than no twin: every concurrency test
 * written against it would be asserting behaviour production does not have.
 *
 * READS are serialized for the same reason. A claim writes the label, then the rows,
 * then the watermark; a read landing between those steps would see a label with no rows
 * — which the state resolver reports as `unavailable`, a permanent-looking state — and
 * production's single script never exposes that window at all.
 */
export function createOutcomeStore(kv: KvStore): OutcomeStore {
  const read = async (mondayItemId: string, generation: number): Promise<StatusLabel | null> => {
    const raw = await kv.get(labelKey(mondayItemId, generation));
    // A value that isn't a terminal label is corruption, not an outcome. Treating it
    // as absent lets the caller recompute rather than write nonsense to the board.
    return isStatusLabel(raw) ? raw : null;
  };

  const readCompletedGeneration = async (mondayItemId: string): Promise<number> =>
    parseWatermark(await kv.get(watermarkKey(mondayItemId)), mondayItemId);

  /**
   * One operation at a time per training. Keyed by item, so unrelated trainings still
   * run concurrently; the tail is dropped once it is the last one, so the map cannot
   * grow with every training a long-lived process ever sees.
   *
   * The `read`/`readCompletedGeneration` locals above are the UNserialized forms, used
   * from inside a claim — going through `serialize` there would queue behind the claim's
   * own entry and deadlock.
   */
  const inFlight = new Map<string, Promise<unknown>>();

  function serialize<T>(mondayItemId: string, run: () => Promise<T>): Promise<T> {
    const previous = inFlight.get(mondayItemId) ?? Promise.resolve();
    // `run` on both settlements: one caller's failure must not cancel the next claim.
    const result = previous.then(run, run);
    const tail: Promise<void> = result.then(
      () => {
        if (inFlight.get(mondayItemId) === tail) {
          inFlight.delete(mondayItemId);
        }
      },
      () => {
        if (inFlight.get(mondayItemId) === tail) {
          inFlight.delete(mondayItemId);
        }
      }
    );
    inFlight.set(mondayItemId, tail);
    return result;
  }

  return {
    read: (mondayItemId, generation) => serialize(mondayItemId, () => read(mondayItemId, generation)),

    readCompletedGeneration: (mondayItemId) =>
      serialize(mondayItemId, () => readCompletedGeneration(mondayItemId)),

    readDetail: (mondayItemId, generation) =>
      serialize(mondayItemId, async () =>
        parseDetail(await kv.get(rowsKey(mondayItemId, generation)))
      ),

    readRowsTtl: (mondayItemId, generation) =>
      serialize(mondayItemId, () => kv.ttl(rowsKey(mondayItemId, generation))),

    // `async` so an invalid claim REJECTS rather than throwing synchronously. The
    // interface promises a promise, and a caller using `.catch()` would otherwise miss
    // the one error that must never pass unnoticed.
    async claim(mondayItemId, generation, claim) {
      // Both validations run before the first write. The Lua below is ordered the same
      // way for the same reason — see its comment.
      const label = claimLabel(claim);
      const encoded = encodeDetail(claim);

      return serialize(mondayItemId, async () => {
        const watermark = await readCompletedGeneration(mondayItemId);

        const won = await kv.setIfAbsent(labelKey(mondayItemId, generation), label);
        if (!won) {
          // Lost the race. Re-read rather than assume: the winner's label is the one
          // already on its way to the board, and its rows are the ones to keep.
          return (await read(mondayItemId, generation)) ?? label;
        }
        await kv.set(rowsKey(mondayItemId, generation), encoded, { ttlMs: ROWS_TTL_MS });
        if (generation > watermark) {
          await kv.set(watermarkKey(mondayItemId), String(generation));
        }
        return label;
      });
    },
  };
}

/**
 * Claim the label, and ONLY if this call won it, write the detail and raise the
 * watermark — one round trip, no window in between.
 *
 * **The watermark is read and validated first, before any write.** Redis runs a script
 * without interleaving, but it does NOT roll back the writes a script made before it
 * errored. Validating late would therefore be the worst of both: the permanent label and
 * the rows land, `tonumber` then fails the comparison, the caller sees an error — and
 * its retry finds the label, skips compute, and leaves the outcome half-committed on top
 * of a watermark still corrupt. Failing before `SET NX` leaves all three keys untouched,
 * which is what makes the error safe to retry. Same fail-loud policy, and now the same
 * ordering, as {@link parseWatermark} and the in-memory twin.
 *
 * The upper bound matters as much as the sign. Lua numbers are doubles, so `tonumber`
 * turns a 30-digit string into `1e30` — integral and positive, and therefore accepted by
 * a modulo check alone. `parseWatermark` rejects it (`Number.isSafeInteger`), so the two
 * sides would disagree in the worst possible direction: the claim commits, `1e30` is
 * larger than any real generation so it is never overwritten, and every later read of
 * that training throws. The training would be wedged for good. Both sides stop at
 * `Number.MAX_SAFE_INTEGER`.
 *
 * KEYS: label, rows, watermark · ARGV: label, detailJson, ttlMs, generation
 * → [won, authoritativeLabel]
 */
const LUA_CLAIM = `
local MAX_SAFE = 9007199254740991
local current = 0
local stored = redis.call('GET', KEYS[3])
if stored then
  current = tonumber(stored)
  if not current or current < 0 or current > MAX_SAFE or current % 1 ~= 0 then
    return redis.error_reply('corrupt completed-generation watermark: ' .. tostring(stored))
  end
end
if redis.call('SET', KEYS[1], ARGV[1], 'NX') then
  redis.call('SET', KEYS[2], ARGV[2], 'PX', tonumber(ARGV[3]))
  if tonumber(ARGV[4]) > current then
    redis.call('SET', KEYS[3], ARGV[4])
  end
  return {1, ARGV[1]}
end
return {0, redis.call('GET', KEYS[1])}
`;

export function createUpstashOutcomeStore(redis: Redis): OutcomeStore {
  const read = async (mondayItemId: string, generation: number): Promise<StatusLabel | null> => {
    const raw = await redis.get<string>(labelKey(mondayItemId, generation));
    return isStatusLabel(raw) ? raw : null;
  };

  return {
    read,

    async readCompletedGeneration(mondayItemId) {
      return parseWatermark(await redis.get<string>(watermarkKey(mondayItemId)), mondayItemId);
    },

    async readDetail(mondayItemId, generation) {
      const raw = await redis.get<string>(rowsKey(mondayItemId, generation));
      // The client may hand back an already-parsed object; re-encode so there is one
      // parsing path and one schema check rather than two shapes to reason about.
      return parseDetail(typeof raw === 'string' || raw === null ? raw : JSON.stringify(raw));
    },

    async readRowsTtl(mondayItemId, generation) {
      return ttlStateFromPttl(await redis.pttl(rowsKey(mondayItemId, generation)));
    },

    async claim(mondayItemId, generation, claim) {
      const label = claimLabel(claim);
      // Throws before the script runs, so an invalid detail can never be paired with a
      // permanent label. The script's own precondition is the watermark.
      const encoded = encodeDetail(claim);
      const res = await redis.eval(
        LUA_CLAIM,
        [
          labelKey(mondayItemId, generation),
          rowsKey(mondayItemId, generation),
          watermarkKey(mondayItemId),
        ],
        [label, encoded, String(ROWS_TTL_MS), String(generation)]
      );
      if (!Array.isArray(res) || res.length !== 2) {
        throw new Error('outcome claim: unexpected script reply');
      }
      const authoritative = res[1];
      return isStatusLabel(authoritative) ? authoritative : label;
    },
  };
}
