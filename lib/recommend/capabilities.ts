/**
 * Who may see the recommendations, and who may act on them.
 *
 * Verifying a session token establishes *which Monday user is asking* — nothing more.
 * It does not establish that they may look: the rows hold every trainer's hourly rate
 * and, once M3 lands, their evaluation scores. Remuneration data is not something every
 * account member should be able to read for an arbitrary historical training id, and
 * "they had a valid token" is not an access policy.
 *
 * ## Three capabilities, and deliberately no hierarchy
 *
 * | capability | grants |
 * |---|---|
 * | `view` | see the list at all (`GET`) |
 * | `plan`  | recalculate, and set `Benaderd` |
 * | `full`  | see rates, totals and scores rather than the restricted shape, plus the
 *   client and time of a trainer's other trainings that same day |
 *
 * A ladder — `view ⊂ plan ⊂ full` — is the tempting shape and the wrong one: it makes
 * "may see exact rates" imply "may spend money on recomputation and edit shared state",
 * which are unrelated concerns. Someone in finance can reasonably hold `view,full` and
 * never `plan`; a planner can hold `view,plan` and never `full`.
 *
 * `view` is still the foundation in practice — `plan` or `full` without it grants
 * nothing anyone can reach — so that combination is rejected as a configuration error
 * rather than silently producing a user who can do nothing.
 *
 * ## Defaults for the account, overrides per user
 *
 * `MONDAY_RECOMMENDATION_DEFAULT_CAPS` is what every verified member of the account
 * gets. ITG's decision (6-Aug-2026) is that anyone who can open the boards can use the
 * list, so in production it is `view,plan,full` and the per-user map is empty.
 *
 * **The default is account-wide, not board-scoped, and those are not the same set.** A
 * session token names the account and the user; it says nothing about which boards that
 * user can open. So this grant reaches anyone in ITG's Monday account, including someone
 * with no access to the Agenda board at all. Monday's own permissions still govern the
 * *pick*, because that writes client-side as the logged-in user — but they do not govern
 * our read. Narrowing it means naming users in the map instead.
 *
 * ## What `full` grants beyond money, and why that was a deliberate choice
 *
 * The dagbotsing-label shows what else a trainer has on the day being planned. The bare
 * FACT travels with `plan`, because that is what the Kies-button hangs on and a warning
 * belongs with the action it warns about. The **client name and the time** travel with
 * `full`, and that is a widening of "rates, totals and scores" rather than something the
 * old wording already covered.
 *
 * It is recorded here because the account-wide caveat above applies to it in full: `full`
 * is no more board-scoped than `plan` is, so this reaches ITG account members who cannot
 * open the Agenda board. The reasoning ITG accepted (27-Aug-2026):
 *
 * - the same policy already grants **every trainer's hourly rate** on this key, and a
 *   booking is markedly less sensitive than remuneration;
 * - the restricted shape already carries `assignmentsThisMonth` and `assignmentsThisYear`,
 *   which are counts derived from this same Agenda scan, so board-derived data was never
 *   the line `full` drew;
 * - verifying real board access would need the user's own token on our read path, and we
 *   read with a service token — which is exactly why the pick writes client-side instead.
 *
 * What this is NOT: a statement that holding `full` proves Agenda-board access. It does
 * not. Anyone narrowing this later should gate the detail on its own capability rather
 * than reading board access into an existing one.
 *
 * Unset still means NOBODY has access. An empty configuration must deny rather than
 * expose trainer rates, so opening it up stays an explicit act.
 */

export type Capability = 'view' | 'plan' | 'full';

const CAPABILITIES: readonly Capability[] = ['view', 'plan', 'full'];

function isCapability(value: string): value is Capability {
  return CAPABILITIES.some((c) => c === value);
}

export interface Capabilities {
  /** May read the list at all. */
  view: boolean;
  /** May recalculate and set `Benaderd`. */
  plan: boolean;
  /** May see rates, totals and scores, plus same-day schedule details of other trainings. */
  full: boolean;
}

export const NO_CAPABILITIES: Capabilities = { view: false, plan: false, full: false };

export type CapabilityMap = ReadonlyMap<string, ReadonlySet<Capability>>;

export interface CapabilityPolicy {
  /** Per-user overrides. Empty when the default covers everyone. */
  map: CapabilityMap;
  /** What every verified member of the account gets. Empty ⇒ nobody, unless listed. */
  defaults: ReadonlySet<Capability>;
}

/** Parse a bare `view,plan,full` list. Blank ⇒ empty, which denies. */
export function parseCapabilityList(raw: string, source: string): ReadonlySet<Capability> {
  const caps = new Set<Capability>();
  for (const name of raw.split(',').map((n) => n.trim().toLowerCase())) {
    if (name === '') {
      continue;
    }
    if (!isCapability(name)) {
      throw new Error(
        `${source}: unknown capability "${name}" (expected ${CAPABILITIES.join(', ')})`
      );
    }
    caps.add(name);
  }
  return caps;
}

/**
 * Parse `MONDAY_RECOMMENDATION_CAPS`.
 *
 * Format: `userId:cap,cap; userId:cap` — entries separated by `;` or a newline, caps by
 * `,`. Example: `12345678:view,plan; 87654321:view,full`.
 *
 * Malformed input **throws**. Deny-by-default already means a typo grants nothing, but
 * silently — `veiw` would leave a planner staring at a 403 with nothing in the logs
 * explaining why. A deployment that cannot express its own access policy should say so
 * loudly at the first request, not behave like a permissions bug.
 */
export function parseCapabilityMap(raw: string): CapabilityMap {
  const map = new Map<string, Set<Capability>>();

  const entries = raw
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  for (const entry of entries) {
    const separator = entry.indexOf(':');
    if (separator === -1) {
      throw new Error(
        `MONDAY_RECOMMENDATION_CAPS: "${entry}" is not "userId:caps" (e.g. "12345678:view,plan")`
      );
    }

    const userId = entry.slice(0, separator).trim();
    if (!/^\d+$/.test(userId)) {
      throw new Error(`MONDAY_RECOMMENDATION_CAPS: "${userId}" is not a numeric Monday user id`);
    }
    if (map.has(userId)) {
      // Merging or last-wins would quietly discard one of two stated intentions.
      throw new Error(`MONDAY_RECOMMENDATION_CAPS: user ${userId} is listed more than once`);
    }

    const caps = parseCapabilityList(
      entry.slice(separator + 1),
      `MONDAY_RECOMMENDATION_CAPS: user ${userId}`
    );

    if (caps.size === 0) {
      throw new Error(`MONDAY_RECOMMENDATION_CAPS: user ${userId} has no capabilities listed`);
    }

    map.set(userId, new Set(caps));
  }

  return map;
}

/**
 * What this user may do: the account default, plus whatever the map adds for them.
 *
 * A union, so the map can only ever widen. Making a listed entry replace the default
 * would turn "give Tim `full`" into "take everything else away from Tim", which is not
 * what writing that down means.
 */
export function capabilitiesFor(userId: string, policy: CapabilityPolicy): Capabilities {
  const listed = policy.map.get(userId);
  const has = (cap: Capability): boolean => policy.defaults.has(cap) || (listed?.has(cap) ?? false);

  return { view: has('view'), plan: has('plan'), full: has('full') };
}

export function capabilityPolicyFromEnv(): CapabilityPolicy {
  const policy: CapabilityPolicy = {
    map: parseCapabilityMap(process.env.MONDAY_RECOMMENDATION_CAPS ?? ''),
    defaults: parseCapabilityList(
      process.env.MONDAY_RECOMMENDATION_DEFAULT_CAPS ?? '',
      'MONDAY_RECOMMENDATION_DEFAULT_CAPS'
    ),
  };

  /**
   * `plan` or `full` without `view` reaches nothing: the holder cannot open the list to
   * use either. Checked HERE rather than while parsing, because only here are the
   * default and the per-user entry both known — a bare `333:full` is perfectly sensible
   * once the default supplies `view`.
   *
   * The DEFAULT is checked in its own right, not only through the map. With an empty map
   * there is no user to iterate, so `MONDAY_RECOMMENDATION_DEFAULT_CAPS=plan` would
   * otherwise validate cleanly while granting the whole account a capability none of them
   * can reach — and the symptom, everyone getting 403, looks nothing like the cause.
   */
  assertReachable(
    'MONDAY_RECOMMENDATION_DEFAULT_CAPS',
    capabilitiesFor(NOBODY, policy),
    'the default'
  );
  for (const [userId] of policy.map) {
    assertReachable(
      'MONDAY_RECOMMENDATION_CAPS',
      capabilitiesFor(userId, policy),
      `user ${userId}`
    );
  }

  return policy;
}

/**
 * A user id that cannot be in the map — `parseCapabilityMap` accepts digits only — so
 * `capabilitiesFor` returns exactly the account default for it.
 */
const NOBODY = 'no-such-user';

function assertReachable(variable: string, caps: Capabilities, subject: string): void {
  if (caps.view || !(caps.plan || caps.full)) {
    return;
  }
  const granted = [caps.plan ? 'plan' : null, caps.full ? 'full' : null].filter(Boolean).join('+');
  throw new Error(
    `${variable}: ${subject} ends up with ${granted} but not view, so the list cannot be ` +
      `opened at all — add view there, or to MONDAY_RECOMMENDATION_DEFAULT_CAPS`
  );
}

/** The production shape of ITG's decision: everyone in the account, everything. */
export const OPEN_TO_ACCOUNT_CAPS = 'view,plan,full';
