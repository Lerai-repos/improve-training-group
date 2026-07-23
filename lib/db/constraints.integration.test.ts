import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adminClient, truncateDomain } from '@lib/testing/supabase-clients';

const admin = adminClient();
const TEST_RATE_KEY = 'test-overlap-key';

/** Await an insert…select('id').single() and return the new id (no casts, no `!`). */
async function insertedId(
  query: PromiseLike<{
    data: { id: string } | null;
    error: { message: string } | null;
  }>
): Promise<string> {
  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }
  if (!data) {
    throw new Error('insert returned no row');
  }
  return data.id;
}

async function cleanupRateCards(): Promise<void> {
  await admin.from('rate_cards').delete().eq('rate_key', TEST_RATE_KEY);
}

describe('schema constraints', () => {
  beforeEach(async () => {
    await truncateDomain(admin);
    await cleanupRateCards();
  });
  afterEach(async () => {
    await truncateDomain(admin);
    await cleanupRateCards();
  });

  it('rejects overlapping default rate cards for the same key', async () => {
    const first = await admin.from('rate_cards').insert({
      rate_key: TEST_RATE_KEY,
      trainer_id: null,
      valid_from: '2020-01-01',
      valid_until: '2022-01-01',
      hourly_rate_cents: 8000,
    });
    expect(first.error).toBeNull();

    const overlapping = await admin.from('rate_cards').insert({
      rate_key: TEST_RATE_KEY,
      trainer_id: null,
      valid_from: '2021-06-01', // overlaps [2020,2022)
      valid_until: '2023-01-01',
      hourly_rate_cents: 8100,
    });
    expect(overlapping.error).not.toBeNull();
  });

  it('allows adjacent (non-overlapping) default rate cards', async () => {
    await admin.from('rate_cards').insert({
      rate_key: TEST_RATE_KEY,
      trainer_id: null,
      valid_from: '2020-01-01',
      valid_until: '2022-01-01',
      hourly_rate_cents: 8000,
    });
    const adjacent = await admin.from('rate_cards').insert({
      rate_key: TEST_RATE_KEY,
      trainer_id: null,
      valid_from: '2022-01-01', // exclusive upper of previous → no overlap
      valid_until: null,
      hourly_rate_cents: 8200,
    });
    expect(adjacent.error).toBeNull();
  });

  it('cascades junction rows when a training is deleted', async () => {
    const trainerId = await insertedId(
      admin
        .from('trainers')
        .insert({ naam: 'FK', rate_key: 'variabel', external_item_id: 'fk-tr' })
        .select('id')
        .single()
    );
    const trainingId = await insertedId(
      admin.from('trainings').insert({ external_item_id: 'fk-tg' }).select('id').single()
    );
    await admin
      .from('training_trainers')
      .insert({ training_id: trainingId, trainer_id: trainerId });

    await admin.from('trainings').delete().eq('id', trainingId);

    const { count } = await admin
      .from('training_trainers')
      .select('*', { count: 'exact', head: true })
      .eq('trainer_id', trainerId);
    expect(count).toBe(0);
  });

  it('restricts deleting a trainer still linked to a training', async () => {
    const trainerId = await insertedId(
      admin
        .from('trainers')
        .insert({ naam: 'FK2', rate_key: 'variabel', external_item_id: 'fk-tr2' })
        .select('id')
        .single()
    );
    const trainingId = await insertedId(
      admin.from('trainings').insert({ external_item_id: 'fk-tg2' }).select('id').single()
    );
    await admin
      .from('training_trainers')
      .insert({ training_id: trainingId, trainer_id: trainerId });

    const { error } = await admin.from('trainers').delete().eq('id', trainerId);
    expect(error).not.toBeNull(); // ON DELETE RESTRICT
  });

  it('enforces one qualification per trainer×theme', async () => {
    const trainerId = await insertedId(
      admin
        .from('trainers')
        .insert({ naam: 'Q', rate_key: 'variabel', external_item_id: 'q-tr' })
        .select('id')
        .single()
    );
    const themaId = await insertedId(
      admin
        .from('themas')
        .insert({ thema: 'Q-theme', external_item_id: 'q-th' })
        .select('id')
        .single()
    );

    const first = await admin.from('trainer_theme_qualifications').insert({
      trainer_id: trainerId,
      thema_id: themaId,
      qualification: 'groen',
    });
    expect(first.error).toBeNull();

    const dup = await admin.from('trainer_theme_qualifications').insert({
      trainer_id: trainerId,
      thema_id: themaId,
      qualification: 'rood',
    });
    expect(dup.error).not.toBeNull();
  });
});
