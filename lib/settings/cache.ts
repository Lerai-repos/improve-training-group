import { z } from 'zod';

import { createSharedCache } from '@lib/recommend/shared-cache';

import type { KvStore } from '@lib/recommend/kv';
import type { SharedCache } from '@lib/recommend/shared-cache';
import type { SettingsSnapshot } from './snapshot';

/**
 * The settings snapshot, shared and short-lived.
 *
 * One execution is one training, so without a cache a sweep of two dozen trainings
 * reads the Instellingen board two dozen times for values that change a few times a
 * year. With one, it is read at most once per TTL however many jobs are running.
 *
 * Single-flight, owner-only lock release and the failure sentinel all come from
 * `createSharedCache` — the same implementation the workload index uses, so there is
 * one place where those subtleties are right.
 */

/** Five minutes. A board edited a handful of times a year cannot go stale in that. */
export const SETTINGS_TTL_MS = 5 * 60 * 1000;

/**
 * Thirty seconds, and deliberately NOT the data TTL.
 *
 * The engine gets three QStash attempts. Remember a failure for five minutes and one
 * three-second Monday blip poisons all three, manufacturing a terminal FOUT for a
 * source that recovered immediately.
 */
const FAILURE_TTL_MS = 30_000;

/**
 * How long a concurrent job waits for the refresh in front of it.
 *
 * A settings read is several sequential Monday requests — schema, inventory, items —
 * and can legitimately pass three seconds. The shared default is tuned for the workload
 * scan, which is allowed to degrade to `—`; this one is on the engine path, where
 * giving up early spends a QStash attempt on a refresh that was about to succeed.
 * Still well inside the 30s lock lease, so a crashed holder is not waited out.
 */
const MAX_WAIT_MS = 20_000;

const rateCardSchema = z.object({
  rateKey: z.string().min(1),
  trainerId: z.string().nullable(),
  validFrom: z.string().min(1),
  validUntil: z.string().nullable(),
  hourlyRateCents: z.number().int(),
});

/**
 * Validated on the way back out, not trusted.
 *
 * A cache entry outlives the deploy that wrote it, so a shape change must read as a
 * MISS — `decode` returning null — rather than as a half-populated config. Anything
 * unparseable simply causes a fresh read.
 */
const cachedSchema = z.object({
  app: z.object({
    hqAddress: z.string(),
    evaluationThresholdHours: z.number(),
    travelRateTrainerCentsPerKm: z.number(),
    travelRateClientCentsPerKm: z.number(),
    travelTimeThresholdMinutes: z.number(),
    travelTimeMode: z.enum(['per_minute', 'hourly_rate']),
    travelTimeFeePerMinuteCents: z.number(),
    recommendableTrainerGroups: z.array(z.string()),
  }),
  rateCards: z.array(rateCardSchema),
  boardId: z.string().min(1),
  readAt: z.number(),
  fingerprint: z.string().min(1),
});

function decode(raw: string): SettingsSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = cachedSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/**
 * Which deployment is asking.
 *
 * Part of the key because preview and production **share Redis**, and the verification
 * steps deliberately point a preview at an isolated board with broken values in it.
 * Keyed on the board alone, that preview's failure sentinel and its `abc` travel rate
 * would be served to production.
 */
function deploymentOf(env: Readonly<Record<string, string | undefined>>): string {
  // `VERCEL_ENV` alone is not enough: EVERY preview reports `preview`, so two previews
  // on the same board would serve each other's settings.
  //
  // The DEPLOYMENT url comes first, not the commit: two deployments of the same commit
  // with different off-board environment values are exactly the case a SHA cannot tell
  // apart, and that is the ordinary way a preview is re-run with a changed variable.
  // The cost is a cold cache per deployment, which is correct — a new deployment may
  // validate settings differently from the one before it.
  const build = env.VERCEL_URL ?? env.VERCEL_GIT_COMMIT_SHA ?? 'dev';
  return `${env.VERCEL_ENV ?? 'local'}:${build}`;
}

export interface CachedSettingsDeps {
  kv: KvStore;
  load: () => Promise<SettingsSnapshot>;
  boardId: string;
  env?: Readonly<Record<string, string | undefined>>;
  ttlMs?: number;
  sleep?: (ms: number) => Promise<void>;
  token?: () => string;
}

export function createCachedSettings(deps: CachedSettingsDeps): SharedCache<SettingsSnapshot> {
  const scope = `${deploymentOf(deps.env ?? process.env)}:${deps.boardId}`;

  return createSharedCache<SettingsSnapshot>({
    kv: deps.kv,
    load: deps.load,
    key: `settings:${scope}`,
    lockKey: `settings-lock:${scope}`,
    encode: (snapshot) => JSON.stringify(snapshot),
    decode,
    ttlMs: deps.ttlMs ?? SETTINGS_TTL_MS,
    failureTtlMs: FAILURE_TTL_MS,
    maxWaitMs: MAX_WAIT_MS,
    label: 'Instellingen',
    sleep: deps.sleep,
    token: deps.token,
  });
}
