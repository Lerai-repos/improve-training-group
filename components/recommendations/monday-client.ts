'use client';

import mondaySdk, { type MondayClientSdk } from 'monday-sdk-js';

/**
 * The Monday iframe seam — everything that touches the SDK, in one place.
 *
 * Two reasons it is a module rather than calls scattered through components:
 *
 * 1. **The SDK must not be initialised at import time.** Next prerenders this page's
 *    HTML at build, where there is no `window`; `mondaySdk()` at module scope would fail
 *    the build. It is created lazily, on first use, which only ever happens in an effect
 *    or an event handler.
 * 2. **It is the one thing no test can drive.** A real Monday iframe cannot be
 *    automated here, so everything above this line takes the interface below as a
 *    dependency and is tested against a fake. What remains untested is precisely the
 *    part the app spike verifies by hand.
 */

/** Monday's four system themes, collapsed to the two this UI actually has. */
export type Appearance = 'light' | 'dark';

export interface MondayContext {
  itemId: string;
  /**
   * The board the planner is looking at — the source of truth for where Pick writes.
   *
   * NOT `agendaBoardId()`. That reads `MONDAY_AGENDA_BOARD_ID`, which Next does not
   * expose to the browser (no `NEXT_PUBLIC_` prefix), so in a client bundle it silently
   * falls back to the production board. While the backend is aimed at the duplicate TEST
   * board, Pick would then write the relation to ITG's REAL Agenda — the exact
   * wrong-board hazard the override exists to avoid, in the one direction that does
   * damage. Taking it from context also makes it right by construction.
   */
  boardId: string;
  theme: Appearance;
}

/**
 * `black` and `hacker` are Monday's two additional DARK themes. Treating anything that
 * is not exactly `dark` as light would show those users a white iframe inside a black
 * workspace.
 */
const DARK_THEMES: readonly string[] = ['dark', 'black', 'hacker'];

function toAppearance(theme: unknown): Appearance {
  return typeof theme === 'string' && DARK_THEMES.includes(theme) ? 'dark' : 'light';
}

export interface MondayBridge {
  /** Current context, once. */
  context(): Promise<MondayContext>;
  /** Context changes — the item can change under an open view. Returns an unsubscribe. */
  onContextChange(listener: (context: MondayContext) => void): () => void;
  /** A fresh session token. Fetched per call, never cached: they expire. */
  sessionToken(): Promise<string>;
  /**
   * A Monday API call as the logged-in user, so THEIR permissions apply.
   *
   * Returns `unknown`, not a generic. A type parameter here would be a promise the
   * bridge cannot keep — nothing has checked the reply — and honouring it would need a
   * cast. Callers validate what they asked for.
   */
  api(query: string, variables?: Record<string, unknown>): Promise<unknown>;
}

interface RawContext {
  itemId?: unknown;
  boardId?: unknown;
  theme?: unknown;
}

/** Monday sends the item id as a number; the rest of the app speaks strings. */
function toContext(raw: unknown): MondayContext | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const { itemId, boardId, theme }: RawContext = raw;
  if (typeof itemId !== 'number' && typeof itemId !== 'string') {
    return null;
  }
  if (typeof boardId !== 'number' && typeof boardId !== 'string') {
    return null;
  }
  return {
    itemId: String(itemId),
    boardId: String(boardId),
    theme: toAppearance(theme),
  };
}

export function createMondayBridge(): MondayBridge {
  // Lazy: see (1) above.
  //
  // Annotated `MondayClientSdk` because `mondaySdk()` has two overloads — a browser one
  // and a server one — and with no argument TypeScript picks the SERVER shape, which has
  // no `get` or `listen` at all. The annotation selects the overload we actually mean.
  let sdk: MondayClientSdk | null = null;
  const client = (): MondayClientSdk => {
    sdk ??= mondaySdk();
    return sdk;
  };

  return {
    async context() {
      const res = await client().get('context');
      const context = toContext(res.data);
      if (context === null) {
        throw new Error('Monday context did not include an item id');
      }
      return context;
    },

    onContextChange(listener) {
      const unsubscribe = client().listen('context', (res: { data?: unknown }) => {
        const context = toContext(res.data);
        if (context !== null) {
          listener(context);
        }
      });
      // The SDK's unsubscribe is typed loosely; guard rather than assume.
      return () => {
        if (typeof unsubscribe === 'function') {
          unsubscribe();
        }
      };
    },

    async sessionToken() {
      const res = await client().get('sessionToken');
      if (typeof res.data !== 'string' || res.data === '') {
        throw new Error('Monday did not return a session token');
      }
      return res.data;
    },

    async api(query: string, variables?: Record<string, unknown>): Promise<unknown> {
      // Widened on assignment rather than cast. The SDK types the reply as
      // `{ data: any; account_id: number }` and omits `errors` — but GraphQL errors do
      // come back in it, and a query that failed would otherwise surface as `data`
      // being quietly undefined.
      const res: { data: unknown; errors?: unknown } = await client().api(
        query,
        variables ? { variables } : undefined
      );

      if (Array.isArray(res.errors) && res.errors.length > 0) {
        throw new Error(res.errors.map((e: unknown) => String(e)).join('; '));
      }
      if (res.data === undefined || res.data === null) {
        throw new Error('Monday returned no data');
      }
      return res.data;
    },
  };
}
