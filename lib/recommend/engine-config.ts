import { randomUUID } from 'node:crypto';

import { buildAppConfig, type ConfigRowLike } from '@lib/config';
import { AGENDA_2026_BOARD, GROUP_POLICY } from '@lib/monday/board-config';
import { isProductionEnvironment } from '@lib/constants';

import type { EngineConfig } from './service';

import type { RateCard } from '@lib/calc';

/**
 * Engine configuration.
 *
 * ⚠️ ENV IS AN INTERIM HOME, AND IT IS THE WRONG ONE. `docs/build/03-aanbevelingsengine.md`
 * is explicit: "Alle bedragen en drempels komen uit het Instellingen-board, nooit uit
 * de code." These values belong to ITG, not to us:
 *
 *   - the travel rates and the travel-time fee are commercial rates that change;
 *   - `RECOMMENDABLE_TRAINER_GROUPS` IS the fase-2a deliverable "selecteerbare
 *     trainergroepen" — keeping it in env hardcodes it in all but name.
 *
 * Today every one of those needs a developer and a redeploy. The fix is a Monday
 * **Instellingen** board read live into `ConfigRowLike[]`.
 *
 * `buildAppConfig` is deliberately reused UNCHANGED, and that is what makes the move
 * cheap: it already accepts generic key/value rows, so only their SOURCE changes. It
 * is also where the rule lives that a FINANCIAL key missing in production is a hard
 * error rather than a silent default — reimplementing "env with fallbacks" here would
 * quietly restore default travel prices the moment a variable went missing, and the
 * Instellingen reader must preserve that same behaviour for a missing board row.
 */

/** Env var per config key; the key names match the former `config` table rows. */
const ENV_KEYS = [
  'HQ_ADRES',
  'THRESHOLD_HOURS',
  'TRAVEL_RATE_TRAINER_CENTS_PER_KM',
  'TRAVEL_RATE_CLIENT_CENTS_PER_KM',
  'TRAVEL_TIME_THRESHOLD_MINUTES',
  'TRAVEL_TIME_MODE',
  'TRAVEL_TIME_FEE_PER_MINUTE_CENTS',
  'RECOMMENDABLE_TRAINER_GROUPS',
] as const;

/**
 * Present env vars as the same key/value rows `buildAppConfig` already validates.
 *
 * Only `undefined` is filtered — an explicitly EMPTY value is passed through so the
 * schema can reject it. Dropping empties too would make a deliberately cleared
 * `RECOMMENDABLE_TRAINER_GROUPS=''` look absent, silently restoring the default
 * groups instead of failing loudly: exactly the silent config error the
 * absent-vs-present-but-empty distinction exists to catch.
 */
export function configRowsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): ConfigRowLike[] {
  return ENV_KEYS.filter((key) => env[key] !== undefined).map((key) => ({
    key,
    value: env[key] ?? '',
  }));
}

/**
 * The two cohort rates (€88 / €84), keyed by the `rateKey` that `GROUP_POLICY`
 * assigns per Monday group. Effective-dated and open-ended, exactly as the
 * `rate_cards` rows were.
 *
 * Interim: once ITG fills the per-trainer `Uurtarief` field on the trainers board,
 * a personal rate becomes a trainer-scoped card keyed on the Monday item id — the
 * mechanism already works (see `tryResolveHourlyRateCents`), only the source moves.
 */
const COHORT_RATE_CENTS: Record<string, number> = {
  '2020-2024': 8800,
  '2024-heden': 8400,
};

export function defaultRateCards(): RateCard[] {
  const keys = [
    ...new Set(
      Object.values(GROUP_POLICY)
        .map((p) => p.rateKey)
        .filter((k): k is string => k !== null)
    ),
  ];
  return keys.map((rateKey) => {
    const hourlyRateCents = COHORT_RATE_CENTS[rateKey];
    if (hourlyRateCents === undefined) {
      throw new Error(`No hourly rate configured for rateKey "${rateKey}"`);
    }
    return { rateKey, trainerId: null, validFrom: '2000-01-01', validUntil: null, hourlyRateCents };
  });
}

/** Assemble the immutable {@link EngineConfig}. */
export function buildEngineConfig(opts?: {
  gitSha?: string | null;
  ackVersion?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
}): EngineConfig {
  const cfg = buildAppConfig(configRowsFromEnv(opts?.env), {
    isProduction: isProductionEnvironment,
  });
  return {
    boardId: AGENDA_2026_BOARD,
    hqAddress: cfg.hqAddress,
    recommendableGroups: cfg.recommendableTrainerGroups,
    rateCards: defaultRateCards(),
    travelTimeConfig: {
      thresholdMinutes: cfg.travelTimeThresholdMinutes,
      mode: cfg.travelTimeMode,
      feePerMinuteCents: cfg.travelTimeFeePerMinuteCents,
    },
    trainerTravelRateCentsPerKm: cfg.travelRateTrainerCentsPerKm,
    clientTravelRateCentsPerKm: cfg.travelRateClientCentsPerKm,
    gitSha: opts?.gitSha ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    ackVersion: opts?.ackVersion ?? null,
  };
}

/** A unique-per-instance worker owner id (for lease ownership). */
export function newWorkerOwner(): string {
  return `worker-${randomUUID()}`;
}
