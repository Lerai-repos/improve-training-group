import { resolveSettingsBoard, INSTELLINGEN_PRODUCTION } from './board';
import { createCachedSettings } from './cache';
import { readSettings } from './read';
import { buildSettingsSnapshot } from './snapshot';

import type { KvStore } from '@lib/recommend/kv';
import type { SharedCache } from '@lib/recommend/shared-cache';
import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { SettingsBoardConfig } from './read';
import type { SettingsSnapshot } from './snapshot';

/**
 * Board → validated snapshot → cache, assembled once.
 *
 * The whole chain lives behind one call so the composition root cannot accidentally
 * skip a link — in particular, cannot read the board without `assertRequiredKeys`, which
 * is the check standing between a deleted row and a silently restored hardcoded default.
 */

export interface SettingsLoaderDeps {
  client: MondayGraphQLClient;
  kv: KvStore;
  isProduction: boolean;
  /**
   * False until the phase-2a row exists and has been verified. See the rollout order:
   * turning this on before the row is created makes every board a missing-key outage.
   */
  requireTrainerGroups?: boolean;
  now?: () => number;
  env?: Readonly<Record<string, string | undefined>>;
  /** Overridden in tests; production reads the pinned pair. */
  pinned?: SettingsBoardConfig;
  ttlMs?: number;
}

/**
 * One read, no cache and no Redis — for scripts and preflight.
 *
 * A one-shot command has nothing to share a cache with, and requiring `KV_REST_API_*`
 * just to print the configuration would make `groups:list` fail on a laptop that is
 * perfectly able to read the board. Same validation, same failure behaviour; only the
 * caching is absent.
 */
export async function loadSettingsOnce(
  client: MondayGraphQLClient,
  opts: {
    isProduction?: boolean;
    requireTrainerGroups?: boolean;
    env?: Readonly<Record<string, string | undefined>>;
    pinned?: SettingsBoardConfig;
    now?: () => number;
  } = {}
): Promise<SettingsSnapshot> {
  const env = opts.env ?? process.env;
  const board = resolveSettingsBoard(opts.pinned ?? INSTELLINGEN_PRODUCTION, env);
  const raw = await readSettings(client, board);

  return buildSettingsSnapshot(raw, {
    boardId: board.boardId,
    isProduction: opts.isProduction ?? false,
    requireTrainerGroups: opts.requireTrainerGroups ?? false,
    readAt: (opts.now ?? Date.now)(),
    env,
  });
}

export function createSettingsLoader(deps: SettingsLoaderDeps): SharedCache<SettingsSnapshot> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const board = resolveSettingsBoard(deps.pinned ?? INSTELLINGEN_PRODUCTION, env);

  return createCachedSettings({
    kv: deps.kv,
    boardId: board.boardId,
    env,
    ttlMs: deps.ttlMs,
    load: async () => {
      const raw = await readSettings(deps.client, board);
      return buildSettingsSnapshot(raw, {
        boardId: board.boardId,
        isProduction: deps.isProduction,
        requireTrainerGroups: deps.requireTrainerGroups ?? false,
        readAt: now(),
        env,
      });
    },
  });
}
