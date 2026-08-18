import { createHash } from 'node:crypto';

import { buildAppConfig } from '@lib/config';

import { buildRateCards } from './rates';
import { assertRequiredKeys } from './required';

import type { AppConfig, ConfigRowLike } from '@lib/config';
import type { RateCard } from '@lib/calc';
import type { RawSettings } from './read';

/**
 * The board's rows → one validated, immutable value the engine is handed.
 *
 * A VALUE, not a port: the read happens in the composition root and this is what comes
 * out, so no code path inside the engine can observe a failed read and quietly continue
 * on defaults. A failure here throws, reaches QStash, and ends as a visible FOUT.
 */

/**
 * Which settings a run actually used, small enough to store with every outcome.
 *
 * Needed because the five-minute cache breaks the obvious reconstruction: a run at
 * 10:02 legitimately used a snapshot read at 09:58, so lining run time up against
 * Monday's activity log would attribute an edit logged at 10:00 to a run that never
 * saw it. Recording the snapshot's own identity is the only way "the activity log
 * tells you who changed what" stays true.
 */
export interface SettingsProvenance {
  boardId: string;
  readAt: number;
  fingerprint: string;
}

export interface SettingsSnapshot extends SettingsProvenance {
  app: AppConfig;
  rateCards: readonly RateCard[];
}

export function provenanceOf(snapshot: SettingsSnapshot): SettingsProvenance {
  return {
    boardId: snapshot.boardId,
    readAt: snapshot.readAt,
    fingerprint: snapshot.fingerprint,
  };
}

/**
 * Config that is deliberately NOT on the board but is still config.
 *
 * `TRAVEL_TIME_MODE` and `THRESHOLD_HOURS` are withheld from ITG on purpose — the first
 * because selecting `hourly_rate` throws in `travelTimeCompensation`, the second
 * because nothing reads it yet and an inert knob is the worst thing to hand someone who
 * can edit freely. But they remain `AppConfig` fields, so if nobody supplies them
 * `buildAppConfig` fills them from `CONFIG_DEFAULTS` and silently discards whatever
 * production had set — and `travelTimeMode` flows straight into
 * `EngineConfig.travelTimeConfig`, changing how travel time is priced.
 *
 * So they keep coming from the environment. "Not ITG-editable" is not "not configured".
 */
const OFF_BOARD_KEYS = ['TRAVEL_TIME_MODE', 'THRESHOLD_HOURS'] as const;

type Env = Readonly<Record<string, string | undefined>>;

export interface SnapshotOptions {
  boardId: string;
  isProduction: boolean;
  readAt: number;
  env?: Env;
}

/**
 * Rows the board does not carry, taken from the environment — and only when genuinely
 * absent from the board, so a board row always wins once it exists.
 */
function withEnvFallbacks(boardRows: readonly ConfigRowLike[], env: Env): ConfigRowLike[] {
  const present = new Set(boardRows.map((row) => row.key));
  const rows = [...boardRows];

  for (const key of OFF_BOARD_KEYS) {
    if (present.has(key)) {
      continue;
    }
    const value = env[key];
    // Only `undefined` is skipped: an explicitly EMPTY value is passed through so the
    // schema can reject it, exactly as `configRowsFromEnv` does. Dropping empties would
    // make a deliberately cleared selection look absent and restore the defaults.
    if (value !== undefined) {
      rows.push({ key, value });
    }
  }

  return rows;
}

/**
 * A stable hash of what the engine will actually use.
 *
 * Over the PARSED config rather than the raw rows, so it moves when a value moves and
 * not when its formatting does: `0,23` and `0.23` are both 23 cents by the time they
 * arrive, and reporting a change the engine never saw would make the audit trail lie in
 * the other direction.
 *
 * A hash rather than the values themselves, so the HQ address is not copied into every
 * stored outcome for the sake of provenance.
 */
/**
 * The group selection is a SET, so its order and repetition must not move the hash.
 *
 * The env variable lists the groups in whatever order somebody typed them; the board
 * lists them in the dropdown's order. Identical membership, different sequence — and the
 * migration's whole proof is "the fingerprint did not change when the source did". Left
 * as-is, that check would raise a false alarm on a migration that was perfectly correct,
 * which is worse than no check at all: the next one gets ignored.
 */
function canonicalise(app: AppConfig): AppConfig {
  return {
    ...app,
    recommendableTrainerGroups: [...new Set(app.recommendableTrainerGroups)].sort(),
  };
}

function fingerprintOf(app: AppConfig, rateCards: readonly RateCard[]): string {
  const canonical = JSON.stringify({
    app: Object.fromEntries(
      Object.entries(canonicalise(app)).sort(([a], [b]) => a.localeCompare(b))
    ),
    rates: [...rateCards]
      .map((c) => [c.rateKey, c.validFrom, c.validUntil, c.hourlyRateCents])
      .sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function buildSettingsSnapshot(
  raw: RawSettings,
  { boardId, isProduction, readAt, env = process.env }: SnapshotOptions
): SettingsSnapshot {
  /**
   * Required keys are checked against the BOARD ROWS, before any env fallback.
   *
   * Load-bearing while the rollback variables are still configured: an environment that
   * still carries `RECOMMENDABLE_TRAINER_GROUPS` would satisfy a merged check even with
   * no `TRAINERGROEPEN` row on the board, defeating the whole point of this deploy on the
   * one check meant to prove the migration landed.
   *
   * A required key is BY DEFINITION one the board owns. Env can never stand in for it.
   */
  assertRequiredKeys(raw.appRows, { emptySelection: raw.emptyGroupSelection });

  const rows = withEnvFallbacks(raw.appRows, env);

  const app = buildAppConfig(rows, { isProduction });
  const rateCards = buildRateCards(raw.rateCents);

  return { app, rateCards, boardId, readAt, fingerprint: fingerprintOf(app, rateCards) };
}
