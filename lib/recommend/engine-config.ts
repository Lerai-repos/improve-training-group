import { randomUUID } from 'node:crypto';

import { buildAppConfig, type ConfigRowLike } from '@lib/config';
import { agendaBoardId, GROUP_POLICY } from '@lib/monday/board-config';
import { isProductionEnvironment } from '@lib/constants';

import type { EngineConfig } from './service';

import type { RateCard } from '@lib/calc';
import type { SettingsSnapshot } from '@lib/settings';

/**
 * Engine configuration.
 *
 * **The amounts and thresholds now come from the Monday Instellingen board**, as
 * `docs/build/03-aanbevelingsengine.md` always required: *"Alle bedragen en drempels
 * komen uit het Instellingen-board, nooit uit de code."* They are read in the
 * composition root by `lib/settings` and handed to {@link buildEngineConfig} as a
 * value; nothing here reads the environment for them any more.
 *
 * `buildAppConfig` was reused UNCHANGED, which is what made the move cheap: it already
 * accepted generic key/value rows, so only their SOURCE changed. It also remains the
 * place where a FINANCIAL key missing in production is a hard error rather than a
 * silent default — and `lib/settings/required.ts` extends that rule to *every*
 * board-owned key, because a deleted row must not read as "no opinion" either.
 *
 * Two values stay in the environment on purpose, injected as `OFF_BOARD_KEYS`:
 * `TRAVEL_TIME_MODE` (selecting `hourly_rate` throws in `travelTimeCompensation`, and
 * the formula is settled at €1/min) and `THRESHOLD_HOURS` (read by nothing yet — an
 * inert knob is the worst thing to hand someone who can edit freely).
 *
 * What survives below is the OFFLINE path: `configRowsFromEnv` and
 * {@link offlineSettingsSnapshot} exist for `replay-verify` and explicitly-offline
 * scripts, which must never touch a live board.
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

/**
 * Assemble the immutable {@link EngineConfig} from an already-read settings snapshot.
 *
 * The snapshot is a **value, not a port**: it is produced in the composition root and
 * handed in, so no code path inside the engine can observe a failed settings read and
 * carry on with defaults. A failed read throws before this is ever called, which reaches
 * QStash and ends as a visible FOUT — the same contract `readRoster` already has.
 *
 * Kept pure and synchronous for exactly that reason.
 */
export function buildEngineConfig(opts: {
  settings: SettingsSnapshot;
  gitSha?: string | null;
  ackVersion?: string | null;
}): EngineConfig {
  const cfg = opts.settings.app;
  return {
    boardId: agendaBoardId(),
    hqAddress: cfg.hqAddress,
    recommendableGroups: cfg.recommendableTrainerGroups,
    rateCards: [...opts.settings.rateCards],
    travelTimeConfig: {
      thresholdMinutes: cfg.travelTimeThresholdMinutes,
      mode: cfg.travelTimeMode,
      feePerMinuteCents: cfg.travelTimeFeePerMinuteCents,
    },
    trainerTravelRateCentsPerKm: cfg.travelRateTrainerCentsPerKm,
    clientTravelRateCentsPerKm: cfg.travelRateClientCentsPerKm,
    gitSha: opts.gitSha ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    ackVersion: opts.ackVersion ?? null,
  };
}

/**
 * A snapshot built from the ENVIRONMENT — for `replay-verify` and explicitly-offline
 * script runs only, never production.
 *
 * The point of the Instellingen board is that these values stop living in env. This
 * survives because replay must stay hermetic: it proves the engine's output against
 * frozen fixtures, so reading a live board there would make a green run mean nothing.
 */
export function offlineSettingsSnapshot(
  env?: Readonly<Record<string, string | undefined>>
): SettingsSnapshot {
  return {
    app: buildAppConfig(configRowsFromEnv(env), { isProduction: false }),
    rateCards: defaultRateCards(),
    boardId: 'offline',
    readAt: 0,
    fingerprint: 'offline',
  };
}

/** A unique-per-instance worker owner id (for lease ownership). */
export function newWorkerOwner(): string {
  return `worker-${randomUUID()}`;
}
