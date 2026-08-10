import { afterEach, describe, expect, it } from 'vitest';

import {
  capabilitiesFor,
  capabilityPolicyFromEnv,
  NO_CAPABILITIES,
  OPEN_TO_ACCOUNT_CAPS,
  parseCapabilityList,
  parseCapabilityMap,
  type CapabilityPolicy,
} from '../capabilities';

const USER = '87654321';
const OTHER = '11112222';

const policy = (raw: string, defaults = ''): CapabilityPolicy => ({
  map: parseCapabilityMap(raw),
  defaults: parseCapabilityList(defaults, 'test'),
});

describe('parseCapabilityMap', () => {
  it('reads several entries, separated by semicolons or newlines', () => {
    const map = parseCapabilityMap(`${USER}:view,plan\n${OTHER}: view , full `);

    expect([...(map.get(USER) ?? [])]).toEqual(['view', 'plan']);
    expect([...(map.get(OTHER) ?? [])]).toEqual(['view', 'full']);
  });

  it('an empty or blank variable is an empty map, not an error', () => {
    expect(parseCapabilityMap('').size).toBe(0);
    expect(parseCapabilityMap('  \n ; ').size).toBe(0);
  });

  /**
   * Deny-by-default already means a typo grants nothing — but silently. `veiw` would
   * leave a planner staring at a 403 with nothing in the logs to explain it, which
   * reads as a permissions bug rather than the config error it is.
   */
  it('rejects an unknown capability by name', () => {
    expect(() => parseCapabilityMap(`${USER}:veiw`)).toThrow(/unknown capability "veiw"/);
  });

  it('rejects a malformed entry', () => {
    expect(() => parseCapabilityMap('just-a-name')).toThrow(/not "userId:caps"/);
    expect(() => parseCapabilityMap('alice:view')).toThrow(/not a numeric Monday user id/);
    expect(() => parseCapabilityMap(`${USER}:`)).toThrow(/no capabilities listed/);
  });

  it('rejects the same user listed twice, rather than picking one intent', () => {
    expect(() => parseCapabilityMap(`${USER}:view; ${USER}:view,plan`)).toThrow(
      /listed more than once/
    );
  });

  /**
   * The map alone no longer decides reachability — the account default may supply
   * `view` — so a bare `full` parses here and is judged in `capabilityPolicyFromEnv`,
   * where both halves are known.
   */
  it('accepts an entry without view, leaving reachability to the policy', () => {
    expect([...(parseCapabilityMap(`${USER}:full`).get(USER) ?? [])]).toEqual(['full']);
  });
});

describe('parseCapabilityList', () => {
  it('reads a bare list', () => {
    expect([...parseCapabilityList('view, plan ,full', 'test')]).toEqual(['view', 'plan', 'full']);
  });

  it('blank is empty, which denies', () => {
    expect(parseCapabilityList('', 'test').size).toBe(0);
    expect(parseCapabilityList(' , ', 'test').size).toBe(0);
  });

  it('rejects a typo rather than silently granting less', () => {
    expect(() => parseCapabilityList('view,pian', 'test')).toThrow(/unknown capability "pian"/);
  });
});

describe('capabilitiesFor', () => {
  it('grants exactly what the map lists', () => {
    expect(capabilitiesFor(USER, policy(`${USER}:view,plan`))).toEqual({
      view: true,
      plan: true,
      full: false,
    });
  });

  /**
   * No hierarchy. Seeing exact rates and spending money on recomputation are unrelated
   * concerns, and collapsing them into a ladder would hand every finance user the
   * ability to edit shared planning state.
   */
  it('treats full and plan as independent', () => {
    expect(capabilitiesFor(USER, policy(`${USER}:view,full`))).toEqual({
      view: true,
      plan: false,
      full: true,
    });
    expect(capabilitiesFor(USER, policy(`${USER}:view,plan`)).full).toBe(false);
  });

  /**
   * The fail-closed default, and the reason it is a default: an unset variable in a
   * fresh environment must deny rather than expose rates to the whole account.
   */
  it('grants nothing to a user who is not listed', () => {
    expect(capabilitiesFor(USER, policy(`${OTHER}:view,full`))).toEqual(NO_CAPABILITIES);
  });

  it('an empty map denies everyone', () => {
    expect(capabilitiesFor(USER, policy(''))).toEqual(NO_CAPABILITIES);
  });

  /**
   * ITG's decision, 6-Aug-2026: anyone who can open the boards can use the list. Note
   * what this actually grants — every verified member of the ACCOUNT, which is a wider
   * set than "has access to the Agenda board". The session token cannot tell us the
   * narrower one.
   */
  it('gives every account member whatever the default lists', () => {
    expect(capabilitiesFor(USER, policy('', 'view,plan,full'))).toEqual({
      view: true,
      plan: true,
      full: true,
    });
  });

  it('a partial default grants only what it names', () => {
    expect(capabilitiesFor(USER, policy('', 'view'))).toEqual({
      view: true,
      plan: false,
      full: false,
    });
  });

  /**
   * The map may only widen. Making a listed entry REPLACE the default would turn "give
   * this user full" into "take everything else away from them", which is not what
   * writing that down means.
   */
  it('unions the map with the default rather than replacing it', () => {
    expect(capabilitiesFor(USER, policy(`${USER}:full`, 'view'))).toEqual({
      view: true,
      plan: false,
      full: true,
    });
  });
});

describe('capabilityPolicyFromEnv', () => {
  const VARS = ['MONDAY_RECOMMENDATION_CAPS', 'MONDAY_RECOMMENDATION_DEFAULT_CAPS'];

  afterEach(() => {
    for (const v of VARS) {
      delete process.env[v];
    }
  });

  it('denies everyone when nothing is configured', () => {
    const p = capabilityPolicyFromEnv();
    expect(p.map.size).toBe(0);
    expect(p.defaults.size).toBe(0);
    expect(capabilitiesFor(USER, p)).toEqual(NO_CAPABILITIES);
  });

  it('reads the map', () => {
    process.env.MONDAY_RECOMMENDATION_CAPS = `${USER}:view,plan,full`;
    expect(capabilitiesFor(USER, capabilityPolicyFromEnv())).toEqual({
      view: true,
      plan: true,
      full: true,
    });
  });

  /** The production configuration: no map at all, everything to the account. */
  it('reads the account-wide default', () => {
    process.env.MONDAY_RECOMMENDATION_DEFAULT_CAPS = OPEN_TO_ACCOUNT_CAPS;

    const p = capabilityPolicyFromEnv();

    expect(p.map.size).toBe(0);
    expect(capabilitiesFor('any-user-at-all', p)).toEqual({ view: true, plan: true, full: true });
  });

  /**
   * A user who ends up able to act but not to look is a configuration mistake, and the
   * only place it can be spotted is here — the map alone cannot know whether the default
   * supplies `view`.
   */
  it('rejects a combination that leaves someone unable to open the list', () => {
    process.env.MONDAY_RECOMMENDATION_CAPS = `${USER}:full`;
    expect(() => capabilityPolicyFromEnv()).toThrow(/but not view/);

    process.env.MONDAY_RECOMMENDATION_DEFAULT_CAPS = 'view';
    expect(() => capabilityPolicyFromEnv()).not.toThrow();
  });

  /**
   * With an empty map there is no user to iterate, so a default of `plan` alone would
   * validate cleanly while granting the whole account something none of them can reach.
   * The symptom — everyone gets 403 — looks nothing like the cause.
   */
  it('rejects a default-only policy that nobody could use', () => {
    process.env.MONDAY_RECOMMENDATION_DEFAULT_CAPS = 'plan';
    expect(() => capabilityPolicyFromEnv()).toThrow(/but not view/);

    process.env.MONDAY_RECOMMENDATION_DEFAULT_CAPS = 'plan,full';
    expect(() => capabilityPolicyFromEnv()).toThrow(/MONDAY_RECOMMENDATION_DEFAULT_CAPS/);

    process.env.MONDAY_RECOMMENDATION_DEFAULT_CAPS = 'view,plan';
    expect(() => capabilityPolicyFromEnv()).not.toThrow();
  });

  it('rejects a typo in the default rather than quietly granting less', () => {
    process.env.MONDAY_RECOMMENDATION_DEFAULT_CAPS = 'view,plna';
    expect(() => capabilityPolicyFromEnv()).toThrow(/unknown capability "plna"/);
  });
});
