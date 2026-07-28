import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adminClient, truncateDomain } from '@lib/testing/supabase-clients';
import type { Json } from '@lib/types/database.gen';

/**
 * Phase-1 DB foundation: the recommendation-engine RPCs, lifecycle, and the
 * current_recommendations view. Exercises enqueue dedup + atomic generation, the
 * claim lease, apply_recommendations (append + generation CAS), the delivery lease
 * + fencing, and the view's "newer failed run hides an older delivered one" rule.
 */

const admin = adminClient();
const BOARD = '5087396949';
const GROUPS = ['topics', 'nieuwe_groep__1'];

/** Read a field off a jsonb RPC return without casting (narrows the Json union). */
function jsonField(v: Json | null, key: string): Json | undefined {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v[key];
  }
  return undefined;
}

async function cleanRecommendations(): Promise<void> {
  const ANCIENT = '1900-01-01';
  await admin.from('recommendations').delete().gte('created_at', ANCIENT);
  await admin.from('recommendation_runs').delete().gte('created_at', ANCIENT);
  await admin.from('recommendation_generation').delete().neq('training_external_id', '');
  await admin.from('travel_cache').delete().gte('fetched_at', ANCIENT);
}

async function insertTrainer(ext: string, group = 'topics'): Promise<string> {
  const { data, error } = await admin
    .from('trainers')
    .insert({
      source_system: 'monday',
      external_item_id: ext,
      naam: `T${ext}`,
      monday_group: group,
    })
    .select('id')
    .single();
  if (error) {
    throw new Error(`trainer ${ext}: ${error.message}`);
  }
  return data.id;
}

async function insertThema(ext: string): Promise<string> {
  const { data, error } = await admin
    .from('themas')
    .insert({ source_system: 'monday', external_item_id: ext, thema: `Th${ext}` })
    .select('id')
    .single();
  if (error) {
    throw new Error(`thema ${ext}: ${error.message}`);
  }
  return data.id;
}

async function insertTraining(ext: string): Promise<string> {
  const { data, error } = await admin
    .from('trainings')
    .insert({ source_system: 'monday', external_item_id: ext, external_board_id: BOARD })
    .select('id')
    .single();
  if (error) {
    throw new Error(`training ${ext}: ${error.message}`);
  }
  return data.id;
}

async function linkThema(trainingId: string, themaId: string): Promise<void> {
  const { error } = await admin
    .from('training_themas')
    .insert({ training_id: trainingId, thema_id: themaId });
  if (error) {
    throw new Error(`link thema: ${error.message}`);
  }
}

async function green(trainerId: string, themaId: string): Promise<void> {
  const { error } = await admin
    .from('trainer_theme_qualifications')
    .insert({ trainer_id: trainerId, thema_id: themaId, effective_qualification: 'green' });
  if (error) {
    throw new Error(`green: ${error.message}`);
  }
}

async function enqueue(triggerUuid: string, itemId: string, kind = 'group_move') {
  const { data, error } = await admin.rpc('enqueue_recommendation_run', {
    p_trigger_uuid: triggerUuid,
    p_trigger_kind: kind,
    p_monday_item_id: itemId,
  });
  if (error || !data) {
    throw new Error(`enqueue: ${error?.message ?? 'no row'}`);
  }
  return data;
}

async function claim() {
  const { data, error } = await admin.rpc('claim_recommendation_run', {
    p_owner: 'test-worker',
    p_lease_seconds: 60,
  });
  if (error) {
    throw new Error(`claim: ${error.message}`);
  }
  return data?.[0] ?? null;
}

async function runStatus(runId: string): Promise<{ status: string; result_status: string | null }> {
  const { data, error } = await admin
    .from('recommendation_runs')
    .select('status, result_status')
    .eq('id', runId)
    .single();
  if (error) {
    throw new Error(`runStatus: ${error.message}`);
  }
  return data;
}

async function recCount(runId: string): Promise<number> {
  const { count } = await admin
    .from('recommendations')
    .select('*', { count: 'exact', head: true })
    .eq('run_id', runId);
  return count ?? 0;
}

beforeEach(async () => {
  await cleanRecommendations();
  await truncateDomain(admin);
});
afterEach(async () => {
  await cleanRecommendations();
});

describe('enqueue_recommendation_run', () => {
  it('dedups on trigger_uuid (idempotent Monday retries)', async () => {
    const a = await enqueue('uuid-1', 'item-1');
    const b = await enqueue('uuid-1', 'item-1');
    expect(a.id).toBe(b.id);
    expect(a.generation).toBe(b.generation);
  });

  it('allocates distinct generations for distinct triggers on one training', async () => {
    const a = await enqueue('uuid-a', 'item-1');
    const b = await enqueue('uuid-b', 'item-1');
    expect(a.generation).toBe(1);
    expect(b.generation).toBe(2);
    expect(b.id).not.toBe(a.id);
  });
});

describe('claim_recommendation_run', () => {
  it('leases the oldest queued run to running, then returns null when drained', async () => {
    await enqueue('uuid-c', 'item-1');
    const claimed = await claim();
    expect(claimed?.status).toBe('running');
    expect(claimed?.lease_owner).toBe('test-worker');
    const again = await claim();
    expect(again).toBeNull();
  });
});

describe('apply_recommendations', () => {
  it('appends ranked rows and finalizes GEREED', async () => {
    const trainingId = await insertTraining('item-1');
    const t1 = await insertTrainer('tr-1');
    await enqueue('uuid-d', 'item-1');
    const run = await claim();
    const res = await admin.rpc('apply_recommendations', {
      p_run_id: run!.id,
      p_training_id: trainingId,
      p_generation: run!.generation,
      p_recs: [{ trainer_ext: 'tr-1', rank: 1, total_cost_cents: 1000, calculate_travel: false }],
    });
    expect(res.error).toBeNull();
    const { data: rows } = await admin
      .from('recommendations')
      .select('trainer_id')
      .eq('run_id', run!.id);
    expect(rows).toHaveLength(1);
    expect(rows?.[0].trainer_id).toBe(t1);
    expect(await runStatus(run!.id)).toEqual({ status: 'computed', result_status: 'GEREED' });
  });

  it('empty recs finalize GEEN MATCH', async () => {
    const trainingId = await insertTraining('item-1');
    await enqueue('uuid-e', 'item-1');
    const run = await claim();
    await admin.rpc('apply_recommendations', {
      p_run_id: run!.id,
      p_training_id: trainingId,
      p_generation: run!.generation,
      p_recs: [],
    });
    expect((await runStatus(run!.id)).result_status).toBe('GEEN MATCH');
  });

  it('generation CAS: a stale run is superseded, not applied', async () => {
    const trainingId = await insertTraining('item-1');
    await insertTrainer('tr-1');
    const genA = await enqueue('uuid-a', 'item-1'); // generation 1
    await enqueue('uuid-b', 'item-1'); // generation 2 (newer) queued
    const run = await claim(); // claims the oldest → genA
    expect(run!.id).toBe(genA.id);
    await admin.rpc('apply_recommendations', {
      p_run_id: run!.id,
      p_training_id: trainingId,
      p_generation: run!.generation,
      p_recs: [{ trainer_ext: 'tr-1', rank: 1, total_cost_cents: 1000 }],
    });
    expect((await runStatus(run!.id)).status).toBe('superseded');
    expect(await recCount(run!.id)).toBe(0);
  });

  it('unresolved trainer ref rolls back (RAISE)', async () => {
    const trainingId = await insertTraining('item-1');
    await enqueue('uuid-f', 'item-1');
    const run = await claim();
    const res = await admin.rpc('apply_recommendations', {
      p_run_id: run!.id,
      p_training_id: trainingId,
      p_generation: run!.generation,
      p_recs: [{ trainer_ext: 'ghost', rank: 1, total_cost_cents: 1 }],
    });
    expect(res.error).not.toBeNull();
    expect(await recCount(run!.id)).toBe(0);
  });
});

describe('delivery lease + fencing + finalize', () => {
  it('acquires, delivers, and converges — older run fenced, view hides stale', async () => {
    const trainingId = await insertTraining('item-1');
    await insertTrainer('tr-1');

    // Generation 1 → computed → delivered.
    await enqueue('uuid-g1', 'item-1');
    const run1 = await claim();
    await admin.rpc('apply_recommendations', {
      p_run_id: run1!.id,
      p_training_id: trainingId,
      p_generation: run1!.generation,
      p_recs: [{ trainer_ext: 'tr-1', rank: 1, total_cost_cents: 500 }],
    });
    const lease1 = await admin.rpc('acquire_delivery_lease', {
      p_run_id: run1!.id,
      p_owner: 'w',
      p_lease_seconds: 60,
    });
    expect(jsonField(lease1.data, 'acquired')).toBe(true);
    await admin.rpc('finalize_delivery', {
      p_run_id: run1!.id,
      p_owner: 'w',
      p_success: true,
      p_error: '',
    });
    expect((await runStatus(run1!.id)).status).toBe('delivered');

    const { data: current1 } = await admin
      .from('current_recommendations')
      .select('id')
      .eq('training_id', trainingId);
    expect(current1).toHaveLength(1);

    // Generation 2 enqueued and fails (FOUT). The view must now be EMPTY.
    await enqueue('uuid-g2', 'item-1');
    const run2 = await claim();
    await admin
      .from('recommendation_runs')
      .update({ status: 'failed', result_status: 'FOUT' })
      .eq('id', run2!.id);

    const { data: current2 } = await admin
      .from('current_recommendations')
      .select('id')
      .eq('training_id', trainingId);
    expect(current2).toHaveLength(0);

    // The older delivered run can no longer acquire the delivery lease (fenced).
    const staleLease = await admin.rpc('acquire_delivery_lease', {
      p_run_id: run1!.id,
      p_owner: 'w',
      p_lease_seconds: 60,
    });
    expect(jsonField(staleLease.data, 'acquired')).toBe(false);
    expect(jsonField(staleLease.data, 'reason')).toBe('superseded');
  });
});

describe('finalize_delivery owner fence', () => {
  it('a non-owner cannot finalize (no lease clobber); the owner can', async () => {
    const trainingId = await insertTraining('item-1');
    await insertTrainer('tr-1');
    await enqueue('uuid-fence', 'item-1');
    const run = await claim();
    await admin.rpc('apply_recommendations', {
      p_run_id: run!.id,
      p_training_id: trainingId,
      p_generation: run!.generation,
      p_recs: [{ trainer_ext: 'tr-1', rank: 1, total_cost_cents: 1 }],
    });
    const lease = await admin.rpc('acquire_delivery_lease', {
      p_run_id: run!.id,
      p_owner: 'owner-1',
      p_lease_seconds: 60,
    });
    expect(jsonField(lease.data, 'acquired')).toBe(true);

    // Wrong owner → no-op (stays computed, lease untouched).
    await admin.rpc('finalize_delivery', {
      p_run_id: run!.id,
      p_owner: 'owner-2',
      p_success: true,
      p_error: '',
    });
    expect((await runStatus(run!.id)).status).toBe('computed');

    // Correct owner → delivered.
    await admin.rpc('finalize_delivery', {
      p_run_id: run!.id,
      p_owner: 'owner-1',
      p_success: true,
      p_error: '',
    });
    expect((await runStatus(run!.id)).status).toBe('delivered');
  });
});

describe('acquire_delivery_lease same-run fence', () => {
  it('a second owner cannot acquire a run whose lease is still held', async () => {
    const trainingId = await insertTraining('item-1');
    await insertTrainer('tr-1');
    await enqueue('uuid-same-run', 'item-1');
    const run = await claim();
    await admin.rpc('apply_recommendations', {
      p_run_id: run!.id,
      p_training_id: trainingId,
      p_generation: run!.generation,
      p_recs: [{ trainer_ext: 'tr-1', rank: 1, total_cost_cents: 1 }],
    });

    const first = await admin.rpc('acquire_delivery_lease', {
      p_run_id: run!.id,
      p_owner: 'owner-1',
      p_lease_seconds: 60,
    });
    expect(jsonField(first.data, 'acquired')).toBe(true);

    // Same run, different owner, lease still held → busy (previously both acquired).
    const second = await admin.rpc('acquire_delivery_lease', {
      p_run_id: run!.id,
      p_owner: 'owner-2',
      p_lease_seconds: 60,
    });
    expect(jsonField(second.data, 'acquired')).toBe(false);
    expect(jsonField(second.data, 'reason')).toBe('delivery_busy');

    // The lease holder can re-acquire its own run (idempotent retry).
    const again = await admin.rpc('acquire_delivery_lease', {
      p_run_id: run!.id,
      p_owner: 'owner-1',
      p_lease_seconds: 60,
    });
    expect(jsonField(again.data, 'acquired')).toBe(true);
  });
});

describe('eligible_trainers_for_training (snapshot oracle)', () => {
  it('returns effective-green-for-all trainers; excludes red-for-any; zero-theme → none', async () => {
    const training = await insertTraining('item-1');
    const th1 = await insertThema('th-1');
    const th2 = await insertThema('th-2');
    await linkThema(training, th1);
    await linkThema(training, th2);

    const allGreen = await insertTrainer('tr-green');
    await green(allGreen, th1);
    await green(allGreen, th2);

    const partial = await insertTrainer('tr-partial');
    await green(partial, th1); // green for th1 only → NOT eligible

    const { data, error } = await admin.rpc('eligible_trainers_for_training', {
      p_training_id: training,
      p_groups: GROUPS,
    });
    expect(error).toBeNull();
    const ids = (data ?? []).map((r) => r.external_item_id);
    expect(ids).toContain('tr-green');
    expect(ids).not.toContain('tr-partial');

    // Zero-theme training → none.
    const empty = await insertTraining('item-empty');
    const zero = await admin.rpc('eligible_trainers_for_training', {
      p_training_id: empty,
      p_groups: GROUPS,
    });
    expect(zero.data ?? []).toHaveLength(0);
  });
});
