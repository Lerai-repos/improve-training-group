import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMockMondayPort } from '@lib/monday';
import { adminClient, truncateDomain } from '@lib/testing/supabase-clients';

import { syncPlanningFromMonday } from './planning';
import { updateEvaluationSnapshot } from './evaluation';

const admin = adminClient();
const scope = { boardId: '5087396949' };

async function trainingByExt(externalItemId: string) {
  const { data, error } = await admin
    .from('trainings')
    .select('*')
    .eq('external_item_id', externalItemId)
    .single();
  if (error) {
    throw error;
  }
  return data;
}

describe('sync ownership contract + idempotency', () => {
  beforeEach(async () => {
    await truncateDomain(admin);
  });
  afterEach(async () => {
    await truncateDomain(admin);
  });

  it('is idempotent — running the planning sync twice makes no duplicates', async () => {
    const monday = createMockMondayPort();
    const first = await syncPlanningFromMonday(admin, monday, scope);
    const second = await syncPlanningFromMonday(admin, monday, scope);

    // Same counts each run (runId differs per run).
    const { runId: _r1, ...firstCounts } = first;
    const { runId: _r2, ...secondCounts } = second;
    expect(secondCounts).toEqual(firstCounts);

    const { count } = await admin.from('trainings').select('*', { count: 'exact', head: true });
    expect(count).toBe(first.trainings);
  });

  it('a planning re-sync does NOT clobber an imported evaluation snapshot', async () => {
    const monday = createMockMondayPort();
    await syncPlanningFromMonday(admin, monday, scope);

    // Import an evaluation snapshot for a training.
    await updateEvaluationSnapshot(admin, '5087400001', {
      avgOverallGrade: 8.5,
      evaluationCount: 12,
      avgProgramContent: 8,
    });

    // Re-run the planning sync (planning-owned columns only).
    await syncPlanningFromMonday(admin, monday, scope);

    const row = await trainingByExt('5087400001');
    expect(row.avg_overall_grade_snapshot).toBe(8.5);
    expect(row.evaluation_count_snapshot).toBe(12);
    expect(row.avg_program_content_snapshot).toBe(8);
  });

  it('an evaluation update does NOT change planning columns', async () => {
    const monday = createMockMondayPort();
    await syncPlanningFromMonday(admin, monday, scope);

    const before = await trainingByExt('5087400001');

    await updateEvaluationSnapshot(admin, '5087400001', {
      avgOverallGrade: 9,
      evaluationCount: 5,
    });

    const after = await trainingByExt('5087400001');
    expect(after.status).toBe(before.status);
    expect(after.duur_training).toBe(before.duur_training);
    expect(after.omzet_cents).toBe(before.omzet_cents);
    expect(after.datum).toBe(before.datum);
  });
});
