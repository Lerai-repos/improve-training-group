/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { createAdminSupabaseClient } from '@lib/db/admin';
import { assertNonProdTarget, resolveAdminDbUrl } from '@lib/db/target';
import { EMPTY_ACK, parseAcknowledgements } from '@lib/monday';
import {
  AGENDA_2026_BOARD,
  INPLANNEN_GROUP_ID,
  MONDAY_API_VERSION,
} from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import {
  buildEngineConfig,
  createAddressFormatter,
  createGoogleRoutesTransport,
  createMondayReader,
  createMondayStatusWriter,
  createOpenRouterCompletion,
  createRoutesProvider,
  createStubAddressFormatter,
  createStubTravelProvider,
  createSupabaseTravelCache,
  deliverRun,
  newWorkerOwner,
  runRecommendation,
  type ServiceDeps,
} from '@lib/recommend';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Local end-to-end harness: run the recommendation pipeline for ONE real training
 * against live Monday + the local snapshot. Dry-run by default (no Monday write —
 * so no FOUT label needed). Travel/address stub to "online" (fee-only) when the
 * GOOGLE_MAPS_API_KEY / OPENROUTER_API_KEY are absent, so it runs with just the
 * Monday token; the real providers activate automatically once those keys are set.
 *
 *   pnpm tsx scripts/recommend-once.ts [mondayItemId] [--apply]
 */

const ACK_FILE = join(process.cwd(), 'docs', 'm2a', 'acknowledgements.json');
const loadAck = () =>
  existsSync(ACK_FILE)
    ? parseAcknowledgements(JSON.parse(readFileSync(ACK_FILE, 'utf8')))
    : EMPTY_ACK;

async function pickInplannenTraining(
  admin: ReturnType<typeof createAdminSupabaseClient>
): Promise<string | null> {
  const { data } = await admin
    .from('trainings')
    .select('external_item_id, id, training_themas(thema_id)')
    .eq('external_group_id', INPLANNEN_GROUP_ID)
    .is('deleted_at', null)
    .limit(50);
  const withThemes = (data ?? []).find((t) => (t.training_themas ?? []).length > 0);
  return withThemes?.external_item_id ?? data?.[0]?.external_item_id ?? null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const itemArg = args.find((a) => !a.startsWith('--'));

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  assertNonProdTarget(resolveAdminDbUrl());
  const admin = createAdminSupabaseClient();

  const hasMaps = Boolean(process.env.GOOGLE_MAPS_API_KEY);
  const hasLlm = Boolean(process.env.OPENROUTER_API_KEY);
  console.log(
    `Providers → address: ${hasLlm ? 'OpenRouter' : 'STUB (online)'}, travel: ${hasMaps ? 'Google Routes' : 'STUB'}`
  );

  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const deps: ServiceDeps = {
    admin,
    reader: createMondayReader(client),
    addressFormatter: hasLlm
      ? createAddressFormatter(createOpenRouterCompletion(process.env.OPENROUTER_API_KEY ?? ''))
      : createStubAddressFormatter({ kind: 'no_travel_confirmed', reason: 'online' }),
    travelProvider: hasMaps
      ? createRoutesProvider(createGoogleRoutesTransport(process.env.GOOGLE_MAPS_API_KEY ?? ''))
      : createStubTravelProvider(() => ({
          status: 'ok',
          leg: { distanceKm: 0, durationMinutes: 0 },
        })),
    travelCache: createSupabaseTravelCache(admin),
    ack: loadAck(),
    config: await buildEngineConfig(admin),
  };

  const itemId = itemArg ?? (await pickInplannenTraining(admin));
  if (!itemId) {
    throw new Error('No Inplannen training found — pass a Monday item id explicitly.');
  }
  console.log(
    `Training item: ${itemId}${apply ? '  (APPLY — will write Monday status)' : '  (dry-run)'}`
  );

  const owner = newWorkerOwner();
  const enq = await admin.rpc('enqueue_recommendation_run', {
    p_trigger_uuid: `local-${itemId}-${Date.now()}`,
    p_trigger_kind: 'group_move',
    p_monday_item_id: itemId,
  });
  if (enq.error || !enq.data) {
    throw new Error(`enqueue failed: ${enq.error?.message ?? 'no run returned'}`);
  }
  // Claim the run we just enqueued by id (not the oldest queued run).
  const claim = await admin.rpc('claim_recommendation_run_by_id', {
    p_run_id: enq.data.id,
    p_owner: owner,
    p_lease_seconds: 300,
  });
  const run = claim.data?.[0];
  if (!run) {
    throw new Error('claim returned nothing');
  }

  const outcome = await runRecommendation(deps, {
    id: run.id,
    monday_item_id: run.monday_item_id,
    generation: run.generation,
  });
  console.log('\nOutcome:', JSON.stringify(outcome));

  const runRow = await admin
    .from('recommendation_runs')
    .select(
      'candidate_count, eligible_count, recommendation_count, excluded_trainers, failing_stage, result_status'
    )
    .eq('id', run.id)
    .single();
  console.log('Run:', JSON.stringify(runRow.data));

  const recs = await admin
    .from('recommendations')
    .select(
      'rank, total_cost_cents, training_fee_cents, trainer_travel_cost_cents, calculate_travel, trainers(naam, external_item_id)'
    )
    .eq('run_id', run.id)
    .order('rank')
    .limit(15);
  console.log(`\nTop recommendations (${(recs.data ?? []).length} shown):`);
  for (const r of recs.data ?? []) {
    const euro = (c: number | null) => (c === null ? '—' : `€${(c / 100).toFixed(2)}`);
    console.log(
      `  #${r.rank}  ${r.trainers?.naam ?? '?'}  total ${euro(r.total_cost_cents)}  (fee ${euro(r.training_fee_cents)}, travel ${euro(r.trainer_travel_cost_cents)})`
    );
  }

  if (apply) {
    console.log('\nDelivering status to Monday…');
    const writer = createMondayStatusWriter({
      token,
      apiVersion: MONDAY_API_VERSION,
      boardId: AGENDA_2026_BOARD,
    });
    const res = await deliverRun(admin, writer, run.id, owner, 60);
    console.log('Delivery:', JSON.stringify(res));
  }
}

main().catch((error) => {
  console.error('recommend-once failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
