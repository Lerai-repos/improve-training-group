import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMockMondayPort } from '@lib/monday';
import { DEFAULT_TRAINERS, DEFAULT_TRAININGS } from '@lib/monday/__fixtures__/domain';
import { adminClient, truncateDomain } from '@lib/testing/supabase-clients';

import { syncPlanningFromMonday } from './planning';
import { updateEvaluationSnapshot } from './evaluation';

const admin = adminClient();
const scope = { boardId: '5087396949' };

async function trainerCountForTraining(externalItemId: string): Promise<number> {
  const t = await admin
    .from('trainings')
    .select('id')
    .eq('external_item_id', externalItemId)
    .single();
  if (t.error) {
    throw new Error(t.error.message);
  }
  const { count } = await admin
    .from('training_trainers')
    .select('*', { count: 'exact', head: true })
    .eq('training_id', t.data.id);
  return count ?? 0;
}

describe('sync reconciliation + conflicts', () => {
  beforeEach(async () => {
    await truncateDomain(admin);
  });
  afterEach(async () => {
    await truncateDomain(admin);
  });

  it('removes a junction when a trainer is dropped from the source', async () => {
    await syncPlanningFromMonday(admin, createMockMondayPort(), scope);
    expect(await trainerCountForTraining('5087400001')).toBe(1);

    // Re-sync with training 5087400001 stripped of its trainers.
    const trainings = DEFAULT_TRAININGS.map((t) =>
      t.externalItemId === '5087400001' ? { ...t, trainerExternalIds: [] } : t
    );
    await syncPlanningFromMonday(admin, createMockMondayPort({ trainings }), scope);

    expect(await trainerCountForTraining('5087400001')).toBe(0);
  });

  it('removes a qualification dropped from the source', async () => {
    await syncPlanningFromMonday(admin, createMockMondayPort(), scope);
    await syncPlanningFromMonday(admin, createMockMondayPort({ qualifications: [] }), scope);

    const { count } = await admin
      .from('trainer_theme_qualifications')
      .select('*', { count: 'exact', head: true });
    expect(count).toBe(0);
  });

  it('resolves duplicate qualification colors by precedence, no error', async () => {
    const monday = createMockMondayPort({
      qualifications: [
        { trainerExternalId: '1661150001', themaExternalId: '5067920001', qualification: 'rood' },
        { trainerExternalId: '1661150001', themaExternalId: '5067920001', qualification: 'groen' },
      ],
    });
    await syncPlanningFromMonday(admin, monday, scope);

    const trainer = await admin
      .from('trainers')
      .select('id')
      .eq('external_item_id', '1661150001')
      .single();
    const thema = await admin
      .from('themas')
      .select('id')
      .eq('external_item_id', '5067920001')
      .single();
    if (trainer.error) {
      throw new Error(trainer.error.message);
    }
    if (thema.error) {
      throw new Error(thema.error.message);
    }

    const q = await admin
      .from('trainer_theme_qualifications')
      .select('qualification')
      .eq('trainer_id', trainer.data.id)
      .eq('thema_id', thema.data.id)
      .single();
    if (q.error) {
      throw new Error(q.error.message);
    }
    expect(q.data.qualification).toBe('groen'); // groen > rood
  });

  it('dedupes duplicate source ids instead of aborting the upsert (#1)', async () => {
    const monday = createMockMondayPort({
      trainers: [DEFAULT_TRAINERS[0], DEFAULT_TRAINERS[1], { ...DEFAULT_TRAINERS[0] }],
    });
    const result = await syncPlanningFromMonday(admin, monday, scope);
    expect(result.trainers).toBe(2); // 3 rows in, 2 unique
  });

  it('keeps a junction to a master synced in a previous run (#3)', async () => {
    // Run 1: full sync — trainer 1661150001 lands in the DB, with 4 qualifications.
    await syncPlanningFromMonday(admin, createMockMondayPort(), scope);
    expect(await trainerCountForTraining('5087400001')).toBe(1);

    // Run 2: trainings only, trainers NOT in the batch (already in DB). The
    // junction must survive (resolved from the DB), not be reconciled away.
    await syncPlanningFromMonday(
      admin,
      createMockMondayPort({ trainers: [], themas: [], klanten: [], qualifications: [] }),
      scope
    );
    expect(await trainerCountForTraining('5087400001')).toBe(1);

    // A training-only sync must NOT wipe the qualifications of looked-up trainers.
    const { count } = await admin
      .from('trainer_theme_qualifications')
      .select('*', { count: 'exact', head: true });
    expect(count).toBe(4);
  });

  it('does not collide when a partial sync re-returns existing qualifications (#follow-up)', async () => {
    // Run 1: full sync creates 4 qualifications.
    await syncPlanningFromMonday(admin, createMockMondayPort(), scope);

    // Run 2: masters omitted but qualifications still returned (repeating existing
    // pairs). Must not violate the unique (trainer_id, thema_id) constraint.
    const monday = createMockMondayPort({
      trainers: [],
      themas: [],
      klanten: [],
      qualifications: [
        { trainerExternalId: '1661150001', themaExternalId: '5067920001', qualification: 'groen' },
      ],
    });
    await expect(syncPlanningFromMonday(admin, monday, scope)).resolves.toBeDefined();

    // Out-of-scope quals are left untouched — still 4.
    const { count } = await admin
      .from('trainer_theme_qualifications')
      .select('*', { count: 'exact', head: true });
    expect(count).toBe(4);
  });

  it('throws when an evaluation update matches no training', async () => {
    await expect(
      updateEvaluationSnapshot(admin, 'does-not-exist', {
        avgOverallGrade: 8,
        evaluationCount: 3,
      })
    ).rejects.toThrow(/no training matched/);
  });
});
