import type { ConfigRowLike } from '@lib/config';

/**
 * Every key the Instellingen board owns must actually be ON it.
 *
 * ## Why this is not already covered
 *
 * `buildAppConfig` falls back to `CONFIG_DEFAULTS` for an absent **non-financial** key.
 * That was right while the environment was the source — a variable nobody set meant
 * "use the default". It is wrong the moment the board is authoritative, because ITG can
 * *delete a row*, and the deletion would then read as "no opinion" rather than as the
 * mistake it is. Deleting `HQ ADRES` would quietly restore `Wolvenplein 25, Utrecht`
 * and price every training from an address nobody chose.
 *
 * So presence is asserted here, before `buildAppConfig` ever sees the rows, and
 * `CONFIG_DEFAULTS` becomes unreachable in production.
 *
 * ## Enumerated, never counted
 *
 * The list is written out rather than derived or counted. A count invites the failure
 * where one key is validated in two places and another in none; the rate keys are
 * checked *separately and independently* in `rates.ts` for the same reason.
 */

/** Internal `dbKey` → the board row name, so an error names what ITG can actually fix. */
const BOARD_NAME_BY_KEY: Record<string, string> = {
  HQ_ADRES: 'HQ ADRES',
  TRAVEL_RATE_TRAINER_CENTS_PER_KM: 'REISTARIEF TRAINERS',
  TRAVEL_RATE_CLIENT_CENTS_PER_KM: 'REISTARIEF HQ',
  TRAVEL_TIME_THRESHOLD_MINUTES: 'REISTIJD DREMPEL',
  TRAVEL_TIME_FEE_PER_MINUTE_CENTS: 'REISTIJD VERGOEDING',
  RECOMMENDABLE_TRAINER_GROUPS: 'TRAINERGROEPEN',
};

/** The five value rows. `TRAINERGROEPEN` joins them in phase 2a — see the flag below. */
export const REQUIRED_APP_KEYS: readonly string[] = [
  'HQ_ADRES',
  'TRAVEL_RATE_TRAINER_CENTS_PER_KM',
  'TRAVEL_RATE_CLIENT_CENTS_PER_KM',
  'TRAVEL_TIME_THRESHOLD_MINUTES',
  'TRAVEL_TIME_FEE_PER_MINUTE_CENTS',
];

const TRAINER_GROUPS_KEY = 'RECOMMENDABLE_TRAINER_GROUPS';

export interface RequiredKeyOptions {
  /**
   * Whether `TRAINERGROEPEN` must be present.
   *
   * False until the phase-2a migration has created the row and been verified; true in
   * the deploy after. Making it a flag rather than a constant is the rollout ordering
   * expressed in code — turning it on too early makes every existing board a
   * missing-key outage.
   */
  requireTrainerGroups: boolean;
  /**
   * The row is on the board but nothing is selected.
   *
   * A separate signal because the two states need *different* instructions: an absent
   * row has to be created, an empty one has to be filled in. Reporting "de rij ontbreekt"
   * to someone looking straight at that row on the board would send them to build a
   * second one, and a duplicate key is refused.
   */
  emptySelection?: boolean;
}

export function assertRequiredKeys(
  rows: readonly ConfigRowLike[],
  { requireTrainerGroups, emptySelection = false }: RequiredKeyOptions
): void {
  if (requireTrainerGroups && emptySelection) {
    throw new Error(
      `"${BOARD_NAME_BY_KEY[TRAINER_GROUPS_KEY]}" staat op het Instellingen-board, maar er is ` +
        'geen groep geselecteerd in de kolom Groepen — kies er minimaal één'
    );
  }

  const present = new Set(rows.map((row) => row.key));
  const wanted = requireTrainerGroups
    ? [...REQUIRED_APP_KEYS, TRAINER_GROUPS_KEY]
    : REQUIRED_APP_KEYS;

  const missing = wanted.filter((key) => !present.has(key));
  if (missing.length === 0) {
    return;
  }

  // Every missing key at once, by BOARD name: the person fixing this is looking at the
  // board, not at the code, and one round trip should be enough to fix all of them.
  const names = missing.map((key) => BOARD_NAME_BY_KEY[key] ?? key);
  throw new Error(
    `Instellingen-board mist de rij(en): ${names.join(', ')} — ` +
      'voeg ze toe; de engine gebruikt geen standaardwaarde uit de code'
  );
}
