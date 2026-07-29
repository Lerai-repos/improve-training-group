import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { getAppConfig, getRateCards } from '@lib/config';
import { AGENDA_2026_BOARD } from '@lib/monday/board-config';
import type { Database } from '@lib/types/database';

import type { EngineConfig } from './service';

/** Assemble the immutable {@link EngineConfig} from the DB config + rate cards. */
export async function buildEngineConfig(
  admin: SupabaseClient<Database>,
  opts?: { gitSha?: string | null; ackVersion?: string | null }
): Promise<EngineConfig> {
  const cfg = await getAppConfig(admin);
  const rateCards = await getRateCards(admin);
  return {
    boardId: AGENDA_2026_BOARD,
    hqAddress: cfg.hqAddress,
    // Config-driven (fase-2a "selecteerbare trainergroepen"); falls back to the
    // GROUP_POLICY-derived default when the config row is absent.
    recommendableGroups: cfg.recommendableTrainerGroups,
    rateCards,
    travelTimeConfig: {
      thresholdMinutes: cfg.travelTimeThresholdMinutes,
      mode: cfg.travelTimeMode,
      feePerMinuteCents: cfg.travelTimeFeePerMinuteCents,
    },
    trainerTravelRateCentsPerKm: cfg.travelRateTrainerCentsPerKm,
    clientTravelRateCentsPerKm: cfg.travelRateClientCentsPerKm,
    snapshotMaxAgeMs: snapshotMaxAgeMs(),
    gitSha: opts?.gitSha ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    ackVersion: opts?.ackVersion ?? null,
  };
}

const DEFAULT_SNAPSHOT_MAX_AGE_HOURS = 48;
const MS_PER_HOUR = 60 * 60 * 1000;

/** Max snapshot age (env `SNAPSHOT_MAX_AGE_HOURS`, default 48h). */
export function snapshotMaxAgeMs(): number {
  const hours = Number.parseFloat(process.env.SNAPSHOT_MAX_AGE_HOURS ?? '');
  return (
    (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SNAPSHOT_MAX_AGE_HOURS) * MS_PER_HOUR
  );
}

/** A unique-per-instance worker owner id (for lease ownership). */
export function newWorkerOwner(): string {
  return `worker-${randomUUID()}`;
}
