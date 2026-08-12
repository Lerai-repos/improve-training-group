/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { EMPTY_ACK, parseAcknowledgements } from '@lib/monday';
import { ITEM_FIELDS, MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import {
  buildEngineConfig,
  createAddressFormatter,
  createGoogleRoutesTransport,
  createMemoryTravelCacheStore,
  createMondayReader,
  createOpenRouterCompletion,
  createRoutesProvider,
  createStubAddressFormatter,
  createStubTravelProvider,
  createTravelCache,
  readRoster,
  evalStatsEnabled,
  readEvalStats,
  createUpstashKvStore,
  createRedisClient,
  runRecommendation,
  type ServiceDeps,
} from '@lib/recommend';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Local end-to-end harness: run the recommendation pipeline for ONE real training
 * against live Monday. Read-only — it never writes to Monday, and there is no
 * database left to persist to, so the result is printed and discarded.
 *
 * Travel/address stub to "online" (fee-only) when GOOGLE_MAPS_API_KEY /
 * OPENROUTER_API_KEY are absent, so it runs with just the Monday token.
 *
 *   pnpm recommend:once [mondayItemId]
 */

const ACK_FILE = join(process.cwd(), 'docs', 'm2a', 'acknowledgements.json');
const loadAck = () =>
  existsSync(ACK_FILE)
    ? parseAcknowledgements(JSON.parse(readFileSync(ACK_FILE, 'utf8')))
    : EMPTY_ACK;

const euro = (c: number | null): string => (c === null ? '—' : `€${(c / 100).toFixed(2)}`);

async function main(): Promise<void> {
  const itemId = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!itemId) {
    throw new Error('Pass a Monday item id: pnpm recommend:once <mondayItemId>');
  }
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }

  const hasMaps = Boolean(process.env.GOOGLE_MAPS_API_KEY);
  const hasLlm = Boolean(process.env.OPENROUTER_API_KEY);
  console.log(
    `Providers → address: ${hasLlm ? 'OpenRouter' : 'STUB (online)'}, travel: ${hasMaps ? 'Google Routes' : 'STUB'}`
  );

  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const roster = await readRoster(client, ITEM_FIELDS);
  const evaluations = evalStatsEnabled()
    ? await readEvalStats(createUpstashKvStore(createRedisClient()))
    : null;
  console.log(
    `Evaluaties: ${evaluations === null ? 'UIT (zet EVAL_STATS_ENABLED=1)' : `${evaluations.length} rijen`}`
  );
  console.log(`Roster: ${roster.length} trainers (live, all groups)`);

  const deps: ServiceDeps = {
    reader: createMondayReader(client),
    roster,
    // A release-gated input. `null` (flag off) means NOT CONSULTED and keeps the scores
    // inert, which is the pre-gate behaviour; with the flag on this is the live record
    // the nightly job wrote, so the two runs can be diffed to approve the ranking change.
    evaluations,
    addressFormatter: hasLlm
      ? createAddressFormatter(createOpenRouterCompletion(process.env.OPENROUTER_API_KEY ?? ''))
      : createStubAddressFormatter({ kind: 'no_travel_confirmed', reason: 'online' }),
    travelProvider: hasMaps
      ? createRoutesProvider(createGoogleRoutesTransport(process.env.GOOGLE_MAPS_API_KEY ?? ''))
      : createStubTravelProvider(() => ({
          status: 'ok',
          leg: { distanceKm: 0, durationMinutes: 0 },
        })),
    travelCache: createTravelCache(createMemoryTravelCacheStore()),
    ack: loadAck(),
    config: buildEngineConfig(),
  };

  console.log(`Training item: ${itemId}  (read-only)\n`);
  const result = await runRecommendation(deps, itemId);

  if (!result.ok) {
    console.log(`Outcome: FOUT at ${result.failure.stage}`);
    if (result.failure.message) {
      console.log(`  ${result.failure.message}`);
    }
    return;
  }

  console.log(
    `Outcome: ${result.resultStatus}  ` +
      `(candidates ${result.counts.candidate}, eligible ${result.counts.eligible}, ` +
      `ranked ${result.counts.recommended}, cache hits ${result.travelCacheHits})`
  );
  if (result.excluded.length > 0) {
    const byReason = new Map<string, number>();
    for (const e of result.excluded) {
      byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
    }
    console.log(`Excluded: ${[...byReason].map(([r, n]) => `${r}=${n}`).join(', ')}`);
  }

  const byId = new Map(roster.map((t) => [t.externalItemId, t.naam]));
  console.log(`\nTop recommendations:`);
  for (const r of result.recommendations.slice(0, 15)) {
    console.log(
      `  #${r.rank}  ${byId.get(r.externalItemId) ?? r.externalItemId}  ` +
        `total ${euro(r.totalCostCents)}  (fee ${euro(r.trainingFeeCents)}, travel ${euro(r.trainerTravelCostCents)})`
    );
  }
}

main().catch((error) => {
  console.error('recommend-once failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
