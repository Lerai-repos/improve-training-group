import type { SettingsBoardConfig } from './read';

/**
 * Which Instellingen board to read, and the policy that keeps production off the test one.
 *
 * ## Why a pinned constant is not enough on its own
 *
 * Pinning the production board id and then still consulting an environment variable
 * protects nothing: an override accidentally left pointing at the preview board would
 * have production pricing every training from an isolated test board — silently, and
 * with entirely plausible-looking numbers. So the policy is enforced here, on the read
 * path, not only in the destructive-check guard.
 *
 * ## One contract
 *
 * In production the variable **must not exist**. Not "is ignored", not "is accepted if
 * it happens to match" — a rule like that only creates the ambiguity it pretends to
 * resolve. The constant is known before any deploy (the board is created and pinned
 * before deploy ①), so production never needs the variable, and its presence is a
 * misconfiguration whatever its value.
 *
 * Preview and local DO override it: that is how the destructive verification steps
 * point at an isolated board.
 */

/**
 * Filled in from `pnpm instellingen:create` output, together with its Notities group.
 *
 * They travel as a pair because Monday generates the group id **per board** — a single
 * pinned group id would be wrong for the preview board, which has its own.
 *
 * Empty until the board exists. That is a deliberate fail-closed state: reading
 * settings before the board is created must complain, not query board `""`.
 */
export const INSTELLINGEN_PRODUCTION: SettingsBoardConfig = {
  boardId: '5102171946',
  notitiesGroupId: 'group_mm66k260',
};

const OVERRIDE = 'MONDAY_INSTELLINGEN_BOARD_ID';
const GROUP_OVERRIDE = 'MONDAY_INSTELLINGEN_NOTITIES_GROUP_ID';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `VERCEL_ENV`, deliberately NOT `isProductionEnvironment`.
 *
 * That helper is `NODE_ENV === 'production'` (`lib/constants.ts:1`), which is **also
 * true on a built Vercel preview** — so using it here would reject the override on
 * exactly the deployment that needs it.
 */
function isProductionDeployment(env: Env): boolean {
  return env.VERCEL_ENV === 'production';
}

/**
 * The board and its Notities group, resolved TOGETHER.
 *
 * Deliberately one function returning a pair rather than two independent lookups.
 * Monday generates the group id per board, so a preview board has its own — and
 * resolving them separately would let a preview board be paired with the production
 * group id, which either rejects every read or stops recognising that board's notes.
 * Making them inseparable in the type removes the possibility.
 */
export function resolveSettingsBoard(
  pinned: SettingsBoardConfig = INSTELLINGEN_PRODUCTION,
  env: Env = process.env
): SettingsBoardConfig {
  // PRESENCE, not truthiness. "Must not exist in production" has to mean the variable
  // itself, or an explicitly-empty one slips through the rule it is meant to obey.
  const hasOverride = OVERRIDE in env;
  const hasGroupOverride = GROUP_OVERRIDE in env;
  const override = env[OVERRIDE]?.trim();
  const groupOverride = env[GROUP_OVERRIDE]?.trim();

  if (isProductionDeployment(env)) {
    if (hasOverride || hasGroupOverride) {
      throw new Error(
        `${OVERRIDE}/${GROUP_OVERRIDE} zijn gezet in productie. Die horen alleen op preview ` +
          'en lokaal: productie leest altijd het vastgelegde board. Verwijder ze.'
      );
    }
    if (pinned.boardId === '' || pinned.notitiesGroupId === '') {
      throw new Error(
        'Het Instellingen-board is nog niet vastgelegd — draai `pnpm instellingen:create` ' +
          'en vul INSTELLINGEN_PRODUCTION (board id én Notities-groep) in.'
      );
    }
    return pinned;
  }

  /**
   * Half an override is refused in BOTH directions.
   *
   * A board without its group would pair a preview board with the production Notities
   * group. A group without its board is the mirror image and is worse for being quiet:
   * it reads as "I am pointing somewhere isolated" while the pinned production board is
   * what actually gets read.
   */
  const wantsOverride = (override ?? '') !== '' || (groupOverride ?? '') !== '';
  if (wantsOverride) {
    if ((override ?? '') === '' || (groupOverride ?? '') === '') {
      throw new Error(
        `${OVERRIDE} en ${GROUP_OVERRIDE} horen bij elkaar — Monday geeft elk board zijn ` +
          'eigen groep-id, dus één van de twee zetten wijst naar een board dat niet gelezen wordt.'
      );
    }
    return { boardId: override ?? '', notitiesGroupId: groupOverride ?? '' };
  }

  if (pinned.boardId === '') {
    throw new Error(
      'Het Instellingen-board is nog niet vastgelegd en er is geen ' +
        `${OVERRIDE} gezet — zonder een van de twee is er niets te lezen.`
    );
  }
  return pinned;
}

/** Convenience for callers that only need the id. Same policy, same pairing. */
export function settingsBoardId(
  pinned: SettingsBoardConfig = INSTELLINGEN_PRODUCTION,
  env: Env = process.env
): string {
  return resolveSettingsBoard(pinned, env).boardId;
}
