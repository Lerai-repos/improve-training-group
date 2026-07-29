import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { tryResolveHourlyRateCents } from '@lib/calc';
import { EMPTY_ACK } from '@lib/monday';
import { adminClient, truncateDomain } from '@lib/testing/supabase-clients';

import { createStubAddressFormatter, type AddressDecision } from './address';
import { runCronDrain } from './cron';
import { createRecordingStatusWriter, deliverRun } from './delivery';
import { createStubTravelProvider, type RouteElement } from './travel';
import type { CachedLeg } from './travel-cache';
import type { TravelCache } from './travel-resolve';
import {
  runRecommendation,
  type ClaimedRun,
  type EngineConfig,
  type LiveMondayReader,
  type LiveTraining,
  type ServiceDeps,
} from './service';
import type { QualObservation } from './types';
import { deliverWithRepair, type WorkerDeps } from './worker';

const admin = adminClient();
let seq = 0;

const CONFIG: EngineConfig = {
  boardId: '5087396949',
  hqAddress: 'HQ',
  recommendableGroups: ['topics', 'nieuwe_groep__1'],
  rateCards: [
    {
      rateKey: '2020-2024',
      trainerId: null,
      validFrom: '2000-01-01',
      validUntil: null,
      hourlyRateCents: 8800,
    },
  ],
  travelTimeConfig: { thresholdMinutes: 90, mode: 'per_minute', feePerMinuteCents: 100 },
  trainerTravelRateCentsPerKm: 23,
  clientTravelRateCentsPerKm: 45,
  snapshotMaxAgeMs: 365 * 24 * 60 * 60 * 1000,
  gitSha: 'test',
  ackVersion: null,
};

const OK: RouteElement = { status: 'ok', leg: { distanceKm: 10, durationMinutes: 30 } };

/**
 * The slice of the stored `input_artifact` a pricing replay needs. Parsed (not cast)
 * because the column is `Json` — this also asserts the shape survives the round-trip.
 */
const artifactReplaySchema = z.object({
  version: z.number(),
  training: z.object({ datum: z.string() }),
  trainers: z.array(
    z.object({
      id: z.string(),
      externalItemId: z.string(),
      rateKey: z.string().nullable(),
    })
  ),
  rates: z.object({
    rateCards: z.array(
      z.object({
        rateKey: z.string(),
        trainerId: z.string().nullable(),
        validFrom: z.string(),
        validUntil: z.string().nullable(),
        hourlyRateCents: z.number(),
      })
    ),
  }),
});

function memCache(): TravelCache {
  const store = new Map<string, CachedLeg>();
  const k = (o: string, d: string, r: string): string => `${o}|${d}|${r}`;
  return {
    lookup: (o, d, r) => Promise.resolve(store.get(k(o, d, r)) ?? null),
    write: (row) => {
      store.set(k(row.originNorm, row.destinationNorm, row.routingKey), {
        condition: row.condition,
        distanceKm: row.distanceKm,
        durationMinutes: row.durationMinutes,
      });
      return Promise.resolve();
    },
  };
}

function reader(
  training: LiveTraining | null,
  observations: QualObservation[] = []
): LiveMondayReader {
  return {
    readTraining: () => Promise.resolve(training),
    readThemeQualifications: () => Promise.resolve(observations),
  };
}

function deps(over: {
  training: LiveTraining | null;
  observations?: QualObservation[];
  address?: AddressDecision;
  element?: RouteElement;
  config?: EngineConfig;
}): ServiceDeps {
  return {
    admin,
    reader: reader(over.training, over.observations),
    addressFormatter: createStubAddressFormatter(
      over.address ?? { kind: 'travel_required', formatted: 'Dest' }
    ),
    travelProvider: createStubTravelProvider(() => over.element ?? OK),
    travelCache: memCache(),
    ack: EMPTY_ACK,
    config: over.config ?? CONFIG,
  };
}

async function insertTrainer(
  ext: string,
  over: { rateKey?: string | null; group?: string } = {}
): Promise<string> {
  const { data, error } = await admin
    .from('trainers')
    .insert({
      source_system: 'monday',
      external_item_id: ext,
      naam: ext,
      adres: `${ext} Street 1`, // per-trainer so a travel stub can single one out
      monday_group: over.group ?? 'topics',
      rate_key: over.rateKey === undefined ? '2020-2024' : over.rateKey,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? 'no trainer id');
  }
  return data.id;
}

async function insertTrainingWithTheme(itemId: string, themaExt: string): Promise<void> {
  const t = await admin
    .from('trainings')
    .insert({
      source_system: 'monday',
      external_item_id: itemId,
      external_board_id: CONFIG.boardId,
    })
    .select('id')
    .single();
  const th = await admin
    .from('themas')
    .insert({ source_system: 'monday', external_item_id: themaExt, thema: themaExt })
    .select('id')
    .single();
  if (t.error || th.error || !t.data || !th.data) {
    throw new Error(`seed: ${t.error?.message ?? th.error?.message ?? 'no data'}`);
  }
  await admin.from('training_themas').insert({ training_id: t.data.id, thema_id: th.data.id });
}

async function claimNew(itemId: string): Promise<ClaimedRun> {
  seq += 1;
  await admin.rpc('enqueue_recommendation_run', {
    p_trigger_uuid: `u-${seq}`,
    p_trigger_kind: 'group_move',
    p_monday_item_id: itemId,
  });
  const { data } = await admin.rpc('claim_recommendation_run', {
    p_owner: 'w',
    p_lease_seconds: 60,
  });
  const row = data?.[0];
  if (!row) {
    throw new Error('nothing claimed');
  }
  return { id: row.id, monday_item_id: row.monday_item_id, generation: row.generation };
}

async function runResultStatus(runId: string): Promise<string | null> {
  const { data } = await admin
    .from('recommendation_runs')
    .select('result_status')
    .eq('id', runId)
    .single();
  return data?.result_status ?? null;
}

const liveTraining = (itemId: string, themes: string[]): LiveTraining => ({
  externalItemId: itemId,
  themeExternalIds: themes,
  locatie: 'somewhere',
  datum: '2026-02-10',
  duurTraining: 4,
  updatedAt: 'rev-1',
});

beforeEach(async () => {
  await admin.from('recommendations').delete().gte('created_at', '1900-01-01');
  await admin.from('recommendation_runs').delete().gte('created_at', '1900-01-01');
  await admin.from('recommendation_generation').delete().neq('training_external_id', '');
  await truncateDomain(admin);
  // The freshness gate needs a recent OK sync to recommend against.
  await admin.from('sync_runs').insert({ mode: 'apply', status: 'ok', scope: {} });
});

describe('runRecommendation', () => {
  it('GEREED: an effective-green eligible trainer is ranked and persisted', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    const run = await claimNew('T1');
    const out = await runRecommendation(
      deps({
        training: liveTraining('T1', ['TH1']),
        observations: [{ trainerExternalId: 'TR1', themaExternalId: 'TH1', colour: 'groen' }],
      }),
      run
    );
    expect(out).toMatchObject({ ok: true, resultStatus: 'GEREED' });
    const { data: rows } = await admin.from('recommendations').select('*').eq('run_id', run.id);
    expect(rows).toHaveLength(1);
    const { data: runRow } = await admin
      .from('recommendation_runs')
      .select('status, input_artifact_hash, monday_item_revision')
      .eq('id', run.id)
      .single();
    expect(runRow?.status).toBe('computed');
    expect(runRow?.input_artifact_hash).toBeTruthy();
    expect(runRow?.monday_item_revision).toBe('rev-1');
  });

  it('artifact records the internal trainer uuid, so a trainer-scoped rate override replays', async () => {
    // Regression: the artifact used to store only `externalItemId`, while pricing
    // resolves on the internal uuid (`rate_cards.trainer_id`). A replay could then
    // not tell which override applied and would silently fall back to the rateKey
    // default — the run's own price would be unreproducible from its own artifact.
    await insertTrainingWithTheme('T1', 'TH1');
    const trainerId = await insertTrainer('TR1');
    const OVERRIDE_CENTS = 12345;
    const rateCards = [
      ...CONFIG.rateCards,
      {
        rateKey: '2020-2024',
        trainerId,
        validFrom: '2000-01-01',
        validUntil: null,
        hourlyRateCents: OVERRIDE_CENTS,
      },
    ];

    const run = await claimNew('T1');
    const out = await runRecommendation(
      deps({
        training: liveTraining('T1', ['TH1']),
        observations: [{ trainerExternalId: 'TR1', themaExternalId: 'TH1', colour: 'groen' }],
        config: { ...CONFIG, rateCards },
      }),
      run
    );
    expect(out).toMatchObject({ ok: true, resultStatus: 'GEREED' });

    // The override actually drove the persisted price (not the 8800 default).
    const { data: recs } = await admin
      .from('recommendations')
      .select('hourly_rate_cents')
      .eq('run_id', run.id);
    expect(recs?.[0]?.hourly_rate_cents).toBe(OVERRIDE_CENTS);

    const { data: runRow } = await admin
      .from('recommendation_runs')
      .select('input_artifact')
      .eq('id', run.id)
      .single();
    const parsed = artifactReplaySchema.parse(runRow?.input_artifact);
    expect(parsed.version).toBe(2);

    const entry = parsed.trainers.find((t) => t.externalItemId === 'TR1');
    if (!entry || entry.rateKey === null) {
      throw new Error('artifact did not record the trainer');
    }
    expect(entry.id).toBe(trainerId);

    // The point of the fix: re-resolve the price from artifact contents ALONE.
    expect(
      tryResolveHourlyRateCents(
        parsed.rates.rateCards,
        entry.rateKey,
        entry.id,
        parsed.training.datum
      )
    ).toBe(OVERRIDE_CENTS);
  });

  it('GEEN MATCH: no effective-green trainer → empty, GEEN MATCH', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    const run = await claimNew('T1');
    const out = await runRecommendation(
      deps({
        training: liveTraining('T1', ['TH1']),
        observations: [{ trainerExternalId: 'TR1', themaExternalId: 'TH1', colour: 'rood' }],
      }),
      run
    );
    expect(out.resultStatus).toBe('GEEN MATCH');
    const { count } = await admin
      .from('recommendations')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', run.id);
    expect(count).toBe(0);
  });

  it('FOUT: training not in the snapshot → stale_snapshot', async () => {
    const run = await claimNew('GHOST');
    const out = await runRecommendation(deps({ training: liveTraining('GHOST', ['TH1']) }), run);
    expect(out).toMatchObject({ ok: false, resultStatus: 'FOUT', failingStage: 'stale_snapshot' });
  });

  it('FOUT: eligible trainers but no duration is not priced as €0', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    const run = await claimNew('T1');
    const out = await runRecommendation(
      deps({
        training: { ...liveTraining('T1', ['TH1']), duurTraining: null },
        observations: [{ trainerExternalId: 'TR1', themaExternalId: 'TH1', colour: 'groen' }],
      }),
      run
    );
    expect(out.failingStage).toBe('invalid_duration');
  });

  it('FOUT: a themed training with a blank date is invalid input even with zero eligible', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    const run = await claimNew('T1');
    const out = await runRecommendation(
      deps({
        // Themes present, no eligible trainer (no green observations), blank date.
        training: { ...liveTraining('T1', ['TH1']), datum: '' },
      }),
      run
    );
    expect(out).toMatchObject({ resultStatus: 'FOUT', failingStage: 'invalid_date' });
  });

  it('GEEN MATCH: a zero-theme training with no duration is not FOUT (validation gated on themes)', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    const run = await claimNew('T1');
    const out = await runRecommendation(
      deps({
        training: { ...liveTraining('T1', []), duurTraining: null, datum: '' },
      }),
      run
    );
    expect(out.resultStatus).toBe('GEEN MATCH');
  });

  it('FOUT: no recent OK sync → stale_snapshot', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    await admin.from('sync_runs').delete().gte('started_at', '1900-01-01'); // remove the seeded OK sync
    const run = await claimNew('T1');
    const out = await runRecommendation(
      deps({
        training: liveTraining('T1', ['TH1']),
        observations: [{ trainerExternalId: 'TR1', themaExternalId: 'TH1', colour: 'groen' }],
      }),
      run
    );
    expect(out.failingStage).toBe('stale_snapshot');
  });

  it('FOUT: an unresolved location never becomes €0', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    const run = await claimNew('T1');
    const out = await runRecommendation(
      deps({
        training: liveTraining('T1', ['TH1']),
        observations: [{ trainerExternalId: 'TR1', themaExternalId: 'TH1', colour: 'groen' }],
        address: { kind: 'unresolved_location', detail: 'locatie volgt' },
      }),
      run
    );
    expect(out.failingStage).toBe('address');
  });

  it('FOUT: a transient travel failure → travel stage', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    const run = await claimNew('T1');
    const out = await runRecommendation(
      deps({
        training: liveTraining('T1', ['TH1']),
        observations: [{ trainerExternalId: 'TR1', themaExternalId: 'TH1', colour: 'groen' }],
        element: { status: 'transient', detail: 'net' },
      }),
      run
    );
    expect(out.failingStage).toBe('travel');
  });

  it('supersession: a stale generation is not applied', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    const runA = await claimNew('T1'); // generation 1, running
    await admin.rpc('enqueue_recommendation_run', {
      p_trigger_uuid: 'newer',
      p_trigger_kind: 'group_move',
      p_monday_item_id: 'T1',
    }); // generation 2 queued
    const out = await runRecommendation(
      deps({
        training: liveTraining('T1', ['TH1']),
        observations: [{ trainerExternalId: 'TR1', themaExternalId: 'TH1', colour: 'groen' }],
      }),
      runA
    );
    expect(out.superseded).toBe(true);
  });
});

describe('deliverRun convergence', () => {
  it('delivers the latest run; an older run cannot overwrite it (fenced)', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    const writer = createRecordingStatusWriter();
    const obs: QualObservation[] = [
      { trainerExternalId: 'TR1', themaExternalId: 'TH1', colour: 'groen' },
    ];

    const runA = await claimNew('T1'); // gen 1
    await runRecommendation(
      deps({ training: liveTraining('T1', ['TH1']), observations: obs }),
      runA
    );
    await deliverRun(admin, writer, runA.id, 'w', 60);

    const runB = await claimNew('T1'); // gen 2
    await runRecommendation(
      deps({ training: liveTraining('T1', ['TH1']), observations: obs }),
      runB
    );
    await deliverRun(admin, writer, runB.id, 'w', 60);

    // An older delivery arriving late must NOT write again.
    const late = await deliverRun(admin, writer, runA.id, 'w', 60);
    expect(late.delivered).toBe(false);
    expect(late.reason).toBe('superseded');

    expect(await runResultStatus(runB.id)).toBe('GEREED');
    // runB delivered; the last write was for runB, not a stale runA overwrite.
    expect(writer.writes.at(-1)).toEqual({ itemId: 'T1', label: 'GEREED' });
  });
});

describe('zero-eligible short-circuit', () => {
  it('GEEN MATCH is definitive: no address/travel calls, so a provider fault cannot FOUT it', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    const run = await claimNew('T1');

    let addressCalls = 0;
    let travelCalls = 0;
    const base = deps({
      training: liveTraining('T1', ['TH1']),
      // No green observation → nobody eligible.
      observations: [{ trainerExternalId: 'TR1', themaExternalId: 'TH1', colour: 'rood' }],
    });
    const out = await runRecommendation(
      {
        ...base,
        addressFormatter: {
          format: () => {
            addressCalls += 1;
            // A hard provider fault: if it were called, the run would FOUT.
            return Promise.resolve<AddressDecision>({ kind: 'error', detail: 'llm down' });
          },
        },
        travelProvider: createStubTravelProvider(() => {
          travelCalls += 1;
          return { status: 'transient', detail: 'routes down' };
        }),
      },
      run
    );

    expect(out.resultStatus).toBe('GEEN MATCH');
    expect(addressCalls).toBe(0);
    expect(travelCalls).toBe(0);
  });
});

describe('no_rate exclusion (half-configured group degrades, never FOUT)', () => {
  const GREEN = (ext: string): QualObservation[] => [
    { trainerExternalId: ext, themaExternalId: 'TH1', colour: 'groen' },
  ];

  async function excludedOf(
    runId: string
  ): Promise<Array<{ externalItemId: string; reason: string }>> {
    const { data } = await admin
      .from('recommendation_runs')
      .select('excluded_trainers')
      .eq('id', runId)
      .single();
    const raw = data?.excluded_trainers;
    return Array.isArray(raw) ? (raw as Array<{ externalItemId: string; reason: string }>) : [];
  }

  it('an unpriceable trainer is skipped as no_rate; the run still GEREEDs with the rest', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1'); // priceable
    await insertTrainer('TR2', { rateKey: null }); // no cohort → unpriceable
    const run = await claimNew('T1');

    const out = await runRecommendation(
      deps({
        training: liveTraining('T1', ['TH1']),
        observations: [...GREEN('TR1'), ...GREEN('TR2')],
      }),
      run
    );

    expect(out.resultStatus).toBe('GEREED'); // pre-fix this threw → FOUT
    const { data: recs } = await admin
      .from('recommendations')
      .select('trainers(external_item_id)')
      .eq('run_id', run.id);
    expect(recs).toHaveLength(1);
    expect(await excludedOf(run.id)).toContainEqual({ externalItemId: 'TR2', reason: 'no_rate' });
  });

  it('when NO trainer is priceable → GEEN MATCH and no provider is called', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1', { rateKey: null });
    const run = await claimNew('T1');

    let addressCalls = 0;
    let travelCalls = 0;
    const base = deps({ training: liveTraining('T1', ['TH1']), observations: GREEN('TR1') });
    const out = await runRecommendation(
      {
        ...base,
        addressFormatter: {
          format: () => {
            addressCalls += 1;
            return Promise.resolve<AddressDecision>({ kind: 'error', detail: 'llm down' });
          },
        },
        travelProvider: createStubTravelProvider(() => {
          travelCalls += 1;
          return { status: 'transient', detail: 'routes down' };
        }),
      },
      run
    );

    expect(out.resultStatus).toBe('GEEN MATCH');
    expect(addressCalls).toBe(0);
    expect(travelCalls).toBe(0);
  });

  it('reports BOTH no_rate and travel exclusions (append, never overwrite)', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1'); // priceable, routable
    await insertTrainer('TR2', { rateKey: null }); // → no_rate
    await insertTrainer('TR3'); // priceable but unroutable → route_not_found
    const run = await claimNew('T1');

    const base = deps({
      training: liveTraining('T1', ['TH1']),
      observations: [...GREEN('TR1'), ...GREEN('TR2'), ...GREEN('TR3')],
    });
    // Only TR3's origin is unroutable; HQ and the others resolve normally.
    const out = await runRecommendation(
      {
        ...base,
        travelProvider: createStubTravelProvider((origin) =>
          origin === 'TR3 Street 1' ? { status: 'not_found' } : OK
        ),
      },
      run
    );

    expect(out.resultStatus).toBe('GEREED');
    const reasons = await excludedOf(run.id);
    expect(reasons).toContainEqual({ externalItemId: 'TR2', reason: 'no_rate' });
    expect(reasons.some((r) => r.reason === 'route_not_found')).toBe(true);
  });

  it('a trainer-scoped rate OVERRIDE resolves (uuid identity), not excluded as no_rate', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    // Override-only key: no default card exists for it, so the trainer is priceable
    // ONLY if the override matches on the internal uuid.
    const trainerId = await insertTrainer('TR1', { rateKey: 'persoonlijk' });
    const { error } = await admin.from('rate_cards').insert({
      rate_key: 'persoonlijk',
      trainer_id: trainerId,
      valid_from: '2000-01-01',
      valid_until: null,
      hourly_rate_cents: 12_000,
    });
    if (error) {
      throw new Error(error.message);
    }
    const run = await claimNew('T1');

    const base = deps({ training: liveTraining('T1', ['TH1']), observations: GREEN('TR1') });
    const out = await runRecommendation(
      {
        ...base,
        config: {
          ...CONFIG,
          rateCards: [
            ...CONFIG.rateCards,
            {
              rateKey: 'persoonlijk',
              trainerId,
              validFrom: '2000-01-01',
              validUntil: null,
              hourlyRateCents: 12_000,
            },
          ],
        },
      },
      run
    );

    expect(out.resultStatus).toBe('GEREED');
    expect(await excludedOf(run.id)).toHaveLength(0);
    const { data: recs } = await admin
      .from('recommendations')
      .select('hourly_rate_cents')
      .eq('run_id', run.id);
    expect(recs?.[0]?.hourly_rate_cents).toBe(12_000); // the override rate, not a default
  });
});

describe('delivery repair signal', () => {
  it('follows repair_run_id: a generation that supersedes mid-write is delivered in the same pass', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    const obs: QualObservation[] = [
      { trainerExternalId: 'TR1', themaExternalId: 'TH1', colour: 'groen' },
    ];

    // gen 1: computed, and it IS the max generation when its delivery lease is taken.
    const runA = await claimNew('T1');
    await runRecommendation(
      deps({ training: liveTraining('T1', ['TH1']), observations: obs }),
      runA
    );

    // A newer generation lands *during* runA's Monday write — exactly the post-write
    // recheck window finalize_delivery's repair signal exists for.
    const writes: string[] = [];
    let superseded = false;
    const racingWriter = {
      writeStatus: async (itemId: string, label: string): Promise<void> => {
        writes.push(`${itemId}:${label}`);
        if (superseded) {
          return;
        }
        superseded = true;
        const runB = await claimNew('T1'); // gen 2
        await runRecommendation(
          deps({ training: liveTraining('T1', ['TH1']), observations: obs }),
          runB
        );
      },
    };

    const workerDeps: WorkerDeps = {
      ...deps({ training: liveTraining('T1', ['TH1']), observations: obs }),
      statusWriter: racingWriter,
      owner: 'repair-worker',
    };
    await deliverWithRepair(workerDeps, runA.id);

    // The repair hop delivered gen 2 immediately — not on some later cron scan.
    const { data: runs } = await admin
      .from('recommendation_runs')
      .select('generation, status, writeback_status')
      .eq('training_external_id', 'T1')
      .order('generation');
    const newest = runs?.at(-1);
    expect(newest?.generation).toBe(2);
    expect(newest?.status).toBe('delivered');
    expect(writes.length).toBe(2); // gen 1 wrote, then the repair hop wrote gen 2
  });
});

describe('runCronDrain budget', () => {
  function workerDeps(over: {
    training: LiveTraining | null;
    observations?: QualObservation[];
  }): WorkerDeps {
    seq += 1;
    return { ...deps(over), statusWriter: createRecordingStatusWriter(), owner: `cron-w-${seq}` };
  }

  const GREEN: QualObservation[] = [
    { trainerExternalId: 'TR1', themaExternalId: 'TH1', colour: 'groen' },
  ];

  it('claims no new work once the deadline has passed (convergence not starved)', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    await admin.rpc('enqueue_recommendation_run', {
      p_trigger_uuid: 'cron-queued',
      p_trigger_kind: 'group_move',
      p_monday_item_id: 'T1',
    });

    // Deadline already in the past → drain claims nothing, the run stays queued.
    const res = await runCronDrain(workerDeps({ training: liveTraining('T1', ['TH1']) }), {
      nowMs: () => 0,
      budgetMs: 0,
    });
    expect(res.processed).toBe(0);
    const { data } = await admin
      .from('recommendation_runs')
      .select('status')
      .eq('trigger_uuid', 'cron-queued')
      .single();
    expect(data?.status).toBe('queued');
  });

  it('does not claim a compute job when less than a full job budget remains', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    await admin.rpc('enqueue_recommendation_run', {
      p_trigger_uuid: 'cron-tight',
      p_trigger_kind: 'group_move',
      p_monday_item_id: 'T1',
    });

    // 60s of budget left but a job needs 120s reserved → drain claims nothing.
    const res = await runCronDrain(
      workerDeps({ training: liveTraining('T1', ['TH1']), observations: GREEN }),
      { budgetMs: 60_000, jobReserveMs: 120_000 }
    );
    expect(res.processed).toBe(0);
    const { data } = await admin
      .from('recommendation_runs')
      .select('status')
      .eq('trigger_uuid', 'cron-tight')
      .single();
    expect(data?.status).toBe('queued');
  });

  it('processes a queued run when within budget', async () => {
    await insertTrainingWithTheme('T1', 'TH1');
    await insertTrainer('TR1');
    await admin.rpc('enqueue_recommendation_run', {
      p_trigger_uuid: 'cron-ok',
      p_trigger_kind: 'group_move',
      p_monday_item_id: 'T1',
    });

    const res = await runCronDrain(
      workerDeps({ training: liveTraining('T1', ['TH1']), observations: GREEN })
    );
    expect(res.processed).toBe(1);
    const { data } = await admin
      .from('recommendation_runs')
      .select('status')
      .eq('trigger_uuid', 'cron-ok')
      .single();
    expect(data?.status).toBe('delivered');
  });
});
