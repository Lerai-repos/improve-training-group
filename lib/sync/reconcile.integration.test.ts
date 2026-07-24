import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMockMondayPort, EMPTY_ACK, type Acknowledgements } from '@lib/monday';
import {
  DEFAULT_QUALIFICATIONS,
  DEFAULT_TRAINERS,
  DEFAULT_TRAININGS,
} from '@lib/monday/__fixtures__/domain';
import { adminClient, truncateDomain } from '@lib/testing/supabase-clients';

import { syncPlanningFromMonday } from './planning';

const admin = adminClient();
const scope = { boardId: '5087396949' };

type CountTable =
  | 'trainers'
  | 'themas'
  | 'klanten'
  | 'trainings'
  | 'trainer_theme_qual_observations'
  | 'trainer_theme_qualifications';
type MasterTable = 'trainers' | 'themas' | 'trainings';

async function count(table: CountTable): Promise<number> {
  const { count: c, error } = await admin.from(table).select('*', { count: 'exact', head: true });
  if (error) {
    throw new Error(`${table}: ${error.message}`);
  }
  return c ?? 0;
}

async function masterId(table: MasterTable, externalItemId: string): Promise<string> {
  const { data, error } = await admin
    .from(table)
    .select('id')
    .eq('external_item_id', externalItemId)
    .single();
  if (error) {
    throw new Error(`${table} ${externalItemId}: ${error.message}`);
  }
  return data.id;
}

async function trainingTrainerCount(trainingId: string): Promise<number> {
  const { count: c, error } = await admin
    .from('training_trainers')
    .select('*', { count: 'exact', head: true })
    .eq('training_id', trainingId);
  if (error) {
    throw new Error(`training_trainers: ${error.message}`);
  }
  return c ?? 0;
}

async function trainerCountForTraining(externalItemId: string): Promise<number> {
  return trainingTrainerCount(await masterId('trainings', externalItemId));
}

async function effectiveFor(
  trainerExt: string,
  themaExt: string
): Promise<string | null | undefined> {
  const trainerId = await masterId('trainers', trainerExt);
  const themaId = await masterId('themas', themaExt);
  const { data } = await admin
    .from('trainer_theme_qualifications')
    .select('effective_qualification')
    .eq('trainer_id', trainerId)
    .eq('thema_id', themaId)
    .maybeSingle();
  return data?.effective_qualification;
}

describe('full-sync reconcile via apply RPC', () => {
  beforeEach(async () => {
    await truncateDomain(admin);
  });
  afterEach(async () => {
    await truncateDomain(admin);
  });

  it('applies the full graph and derives effective green/red', async () => {
    await syncPlanningFromMonday(admin, createMockMondayPort(), scope);

    expect(await count('trainers')).toBe(2);
    expect(await count('themas')).toBe(2);
    expect(await count('trainings')).toBe(2);
    expect(await count('trainer_theme_qual_observations')).toBe(4);
    expect(await count('trainer_theme_qualifications')).toBe(4);

    // groen→green, rood→red, oranje→null (unconfirmed).
    expect(await effectiveFor('1661150001', '5067920001')).toBe('green');
    expect(await effectiveFor('1661150002', '5067920001')).toBe('red');
    expect(await effectiveFor('1661150001', '5067920002')).toBeNull();
  });

  it('reconciles a junction away when a trainer is dropped from a training', async () => {
    await syncPlanningFromMonday(admin, createMockMondayPort(), scope);
    expect(await trainerCountForTraining('5087400001')).toBe(1);

    const trainings = DEFAULT_TRAININGS.map((t) =>
      t.externalItemId === '5087400001' ? { ...t, trainerExternalIds: [] } : t
    );
    await syncPlanningFromMonday(admin, createMockMondayPort({ trainings }), scope);

    expect(await trainerCountForTraining('5087400001')).toBe(0);
    // The trainer master is still active (full pull), not tombstoned.
    expect(await count('trainers')).toBe(2);
  });

  it('reconciles a qualification colour change and removal', async () => {
    await syncPlanningFromMonday(admin, createMockMondayPort(), scope);
    expect(await effectiveFor('1661150001', '5067920001')).toBe('green');

    // Anna/Feedback flips groen→rood; Anna/Time (oranje) is dropped entirely.
    const qualifications = DEFAULT_QUALIFICATIONS.filter(
      (q) => !(q.trainerExternalId === '1661150001' && q.themaExternalId === '5067920002')
    ).map((q) =>
      q.trainerExternalId === '1661150001' && q.themaExternalId === '5067920001'
        ? { ...q, qualification: 'rood' as const }
        : q
    );
    await syncPlanningFromMonday(admin, createMockMondayPort({ qualifications }), scope);

    expect(await effectiveFor('1661150001', '5067920001')).toBe('red');
    expect(await effectiveFor('1661150001', '5067920002')).toBeUndefined(); // removed
    expect(await count('trainer_theme_qual_observations')).toBe(3);
  });

  it('tombstones a dropped training and un-tombstones it on return', async () => {
    await syncPlanningFromMonday(admin, createMockMondayPort(), scope);
    const trainingId = await masterId('trainings', '5087400002');

    // Drop training 5087400002 from the pull → tombstoned, junctions cleared.
    const trainings = DEFAULT_TRAININGS.filter((t) => t.externalItemId !== '5087400002');
    await syncPlanningFromMonday(admin, createMockMondayPort({ trainings }), scope);

    const dropped = await admin
      .from('trainings')
      .select('deleted_at')
      .eq('id', trainingId)
      .single();
    expect(dropped.data?.deleted_at).not.toBeNull();
    expect(await trainingTrainerCount(trainingId)).toBe(0);

    // Full pull again → un-tombstoned.
    await syncPlanningFromMonday(admin, createMockMondayPort(), scope);
    const back = await admin.from('trainings').select('deleted_at').eq('id', trainingId).single();
    expect(back.data?.deleted_at).toBeNull();
  });

  it('is idempotent — a second identical sync leaves updated_at untouched', async () => {
    await syncPlanningFromMonday(admin, createMockMondayPort(), scope);
    const first = await admin
      .from('trainers')
      .select('updated_at')
      .eq('external_item_id', '1661150001')
      .single();

    await syncPlanningFromMonday(admin, createMockMondayPort(), scope);
    const second = await admin
      .from('trainers')
      .select('updated_at')
      .eq('external_item_id', '1661150001')
      .single();

    expect(second.data?.updated_at).toBe(first.data?.updated_at);
  });

  it('REJECTS an unlisted qualification conflict (fail-closed)', async () => {
    const qualifications = [
      ...DEFAULT_QUALIFICATIONS,
      {
        trainerExternalId: '1661150001',
        themaExternalId: '5067920001',
        qualification: 'rood' as const,
      },
    ];
    await expect(
      syncPlanningFromMonday(admin, createMockMondayPort({ qualifications }), scope)
    ).rejects.toThrow(/conflict/i);
  });

  it('applies an ALLOWLISTED conflict: reviewed effective + both raw observations', async () => {
    const qualifications = [
      ...DEFAULT_QUALIFICATIONS,
      {
        trainerExternalId: '1661150001',
        themaExternalId: '5067920001',
        qualification: 'rood' as const,
      },
    ];
    const ack: Acknowledgements = {
      ...EMPTY_ACK,
      qualConflicts: {
        '1661150001::5067920001': { colours: ['groen', 'rood'], effective: 'green' },
      },
    };
    await syncPlanningFromMonday(admin, createMockMondayPort({ qualifications }), scope, ack);

    const trainerId = await masterId('trainers', '1661150001');
    const themaId = await masterId('themas', '5067920001');
    const obs = await admin
      .from('trainer_theme_qual_observations')
      .select('colour')
      .eq('trainer_id', trainerId)
      .eq('thema_id', themaId);
    expect((obs.data ?? []).map((o) => o.colour).sort()).toEqual(['groen', 'rood']);
    // Allowlisted → effective is the reviewed value.
    expect(await effectiveFor('1661150001', '5067920001')).toBe('green');
  });
});
