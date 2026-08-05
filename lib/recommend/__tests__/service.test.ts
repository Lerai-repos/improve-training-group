import { describe, expect, it } from 'vitest';

import { EMPTY_ACK } from '@lib/monday';

import {
  runRecommendation,
  type EngineConfig,
  type LiveMondayReader,
  type LiveTraining,
  type ServiceDeps,
} from '../service';
import type { CandidateTrainer, QualObservation } from '../types';

import type { RateCard } from '@lib/calc';

/**
 * Converted from the deleted `service.integration.test.ts`. These cover the
 * ORCHESTRATION being rewritten — short-circuits, exclusion merging, fail-closed
 * stages — which live parity against Airtable cannot check: parity runs on drifting
 * live data and can never assert "the travel provider was not called".
 *
 * Queue/lease/delivery cases from the original suite are deliberately not here;
 * they belong to the KV `RunQueue` in the next pass.
 */

const CARD: RateCard = {
  rateKey: '2020-2024',
  trainerId: null,
  validFrom: '2000-01-01',
  validUntil: null,
  hourlyRateCents: 8800,
};

const CONFIG: EngineConfig = {
  boardId: '5087396949',
  hqAddress: 'HQ 1, Utrecht',
  recommendableGroups: ['topics'],
  rateCards: [CARD],
  travelTimeConfig: { thresholdMinutes: 90, mode: 'per_minute', feePerMinuteCents: 100 },
  trainerTravelRateCentsPerKm: 23,
  clientTravelRateCentsPerKm: 45,
  gitSha: null,
  ackVersion: null,
};

const THEME = 'th1';
const training = (over: Partial<LiveTraining> = {}): LiveTraining => ({
  externalItemId: 'tr1',
  themeExternalIds: [THEME],
  locatie: 'Ergens 1',
  datum: '2026-03-01',
  duurTraining: 4,
  updatedAt: 'rev-1',
  ...over,
});

const trainer = (id: string, over: Partial<CandidateTrainer> = {}): CandidateTrainer => ({
  externalItemId: id,
  naam: `T${id}`,
  adres: `Adres ${id}`,
  mondayGroup: 'topics',
  rateKey: '2020-2024',
  ...over,
});

const green = (id: string, thema = THEME): QualObservation => ({
  trainerExternalId: id,
  themaExternalId: thema,
  colour: 'groen',
});

function reader(live: LiveTraining | null, obs: QualObservation[]): LiveMondayReader {
  return {
    readTraining: () => Promise.resolve(live),
    readThemeQualifications: () => Promise.resolve(obs),
  };
}

/** Call counters, so a short-circuit can be asserted as "the provider was NOT called". */
interface Spies {
  addressCalls: number;
  distanceCalls: number;
}

function deps(over: Partial<ServiceDeps> = {}): { deps: ServiceDeps; spies: Spies } {
  const spies: Spies = { addressCalls: 0, distanceCalls: 0 };
  const base: ServiceDeps = {
    reader: reader(training(), [green('a')]),
    roster: [trainer('a')],
    addressFormatter: {
      format: () => {
        spies.addressCalls += 1;
        return Promise.resolve({ kind: 'travel_required', formatted: 'Dest 1' });
      },
    },
    travelProvider: {
      routingKey: () => 'stub:v1',
      distances: (origins: readonly string[]) => {
        spies.distanceCalls += 1;
        return Promise.resolve(
          origins.map(() => ({
            status: 'ok' as const,
            leg: { distanceKm: 10, durationMinutes: 20 },
          }))
        );
      },
    },
    travelCache: {
      lookup: () => Promise.resolve(null),
      write: () => Promise.resolve(),
    },
    ack: EMPTY_ACK,
    config: CONFIG,
    ...over,
  };
  return { deps: base, spies };
}

describe('runRecommendation — success paths', () => {
  it('GEREED: an effective-green eligible trainer is ranked', async () => {
    const { deps: d } = deps();
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.resultStatus).toBe('GEREED');
    expect(r.recommendations.map((x) => x.externalItemId)).toEqual(['a']);
    expect(r.counts).toEqual({ candidate: 1, eligible: 1, recommended: 1 });
    expect(r.mondayItemRevision).toBe('rev-1');
    expect(r.artifactHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('GEEN MATCH: no effective-green trainer', async () => {
    const { deps: d } = deps({
      reader: reader(training(), [
        { trainerExternalId: 'a', themaExternalId: THEME, colour: 'rood' },
      ]),
    });
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.resultStatus).toBe('GEEN MATCH');
    expect(r.recommendations).toHaveLength(0);
  });

  it('a zero-theme training is GEEN MATCH, not FOUT, even with no duration', async () => {
    const { deps: d } = deps({
      reader: reader(training({ themeExternalIds: [], duurTraining: null }), []),
    });
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(true);
    expect(r.resultStatus).toBe('GEEN MATCH');
  });

  it('a confirmed-online training keeps a real decision, not null', async () => {
    const { deps: d } = deps();
    d.addressFormatter = {
      format: () => Promise.resolve({ kind: 'no_travel_confirmed', reason: 'online' }),
    };
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    // null means "stage not evaluated" — an online training is a real answer.
    expect(r.addressDecision).toEqual({ kind: 'no_travel_confirmed', reason: 'online' });
    expect(r.artifact.enrichment.addressDecisionKind).toBe('no_travel_confirmed');
  });

  it('only trainers in a configured group are candidates', async () => {
    const { deps: d } = deps({
      roster: [trainer('a'), trainer('b', { mondayGroup: 'group_mm0d6p4r' })],
      reader: reader(training(), [green('a'), green('b')]),
    });
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.counts.candidate).toBe(1);
    expect(r.recommendations.map((x) => x.externalItemId)).toEqual(['a']);
  });
});

describe('runRecommendation — fail-closed stages', () => {
  it('FOUT load_training when the training cannot be read', async () => {
    const { deps: d } = deps({ reader: reader(null, []) });
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.failure.stage).toBe('load_training');
  });

  it('FOUT invalid_duration — eligible trainers are never priced as €0', async () => {
    const { deps: d } = deps({ reader: reader(training({ duurTraining: null }), [green('a')]) });
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.failure.stage).toBe('invalid_duration');
  });

  it('FOUT invalid_date for a themed training, even with zero eligible trainers', async () => {
    const { deps: d } = deps({ reader: reader(training({ datum: '   ' }), []) });
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.failure.stage).toBe('invalid_date');
  });

  it('FOUT address — an unresolved location never becomes €0 travel', async () => {
    const { deps: d } = deps();
    d.addressFormatter = {
      format: () =>
        Promise.resolve({ kind: 'unresolved_location', detail: 'only a province given' }),
    };
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.failure.stage).toBe('address');
    expect(r.failure.message).toMatch(/province/);
    // TERMINAL: the model read the field fine and the field is unusable. Retrying
    // burns the queue's budget without any chance of a different answer.
    expect(r.failure.retryable).toBe(false);
  });

  it('an address MODEL failure is retryable, unlike an unusable location', async () => {
    const { deps: d } = deps();
    d.addressFormatter = {
      format: () => Promise.resolve({ kind: 'error', detail: 'parse: unexpected token' }),
    };
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.failure.stage).toBe('address');
    expect(r.failure.retryable).toBe(true);
  });

  it('FOUT travel on a transient provider failure, with partial provenance kept', async () => {
    const { deps: d } = deps();
    d.travelProvider = {
      routingKey: () => 'stub:v1',
      distances: () => Promise.reject(new Error('routes 503')),
    };
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.failure.stage).toBe('travel');
    expect(r.failure.retryable).toBe(true);
    // Provenance gathered before the failure survives — it is not fabricated, but
    // it is not thrown away either.
    expect(r.partial.mondayItemRevision).toBe('rev-1');
    expect(r.partial.addressDecision).toEqual({ kind: 'travel_required', formatted: 'Dest 1' });
  });

  it('an unreachable destination is TERMINAL, not a retryable provider hiccup', async () => {
    const { deps: d } = deps();
    d.travelProvider = {
      routingKey: () => 'stub:v1',
      distances: () => Promise.resolve([{ status: 'not_found' }]),
    };
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.failure.stage).toBe('travel');
    expect(r.failure.retryable).toBe(false);
  });

  it('validation failures are terminal', async () => {
    const { deps: d } = deps({ reader: reader(training({ datum: '   ' }), []) });
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.failure.retryable).toBe(false);
  });
});

describe('runRecommendation — provider short-circuits', () => {
  it('zero eligible: GEEN MATCH is definitive, so NO provider is called', async () => {
    const { deps: d, spies } = deps({ reader: reader(training(), []) }); // nobody qualified
    const r = await runRecommendation(d, 'tr1');
    expect(r.resultStatus).toBe('GEEN MATCH');
    expect(spies.addressCalls).toBe(0);
    expect(spies.distanceCalls).toBe(0);
  });

  it('all eligible unpriceable: GEEN MATCH and still no provider call', async () => {
    const { deps: d, spies } = deps({ roster: [trainer('a', { rateKey: null })] });
    const r = await runRecommendation(d, 'tr1');
    expect(r.resultStatus).toBe('GEEN MATCH');
    expect(spies.addressCalls).toBe(0);
    expect(spies.distanceCalls).toBe(0);
  });
});

describe('runRecommendation — exclusions', () => {
  it('an unpriceable trainer is excluded as no_rate; the run still GEREEDs', async () => {
    const { deps: d } = deps({
      roster: [trainer('a'), trainer('b', { rateKey: null })],
      reader: reader(training(), [green('a'), green('b')]),
    });
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.resultStatus).toBe('GEREED');
    expect(r.recommendations.map((x) => x.externalItemId)).toEqual(['a']);
    expect(r.excluded).toContainEqual({ externalItemId: 'b', reason: 'no_rate' });
  });

  it('reports BOTH no_rate and travel exclusions (append, never overwrite)', async () => {
    const { deps: d } = deps({
      roster: [trainer('a'), trainer('b', { rateKey: null }), trainer('c')],
      reader: reader(training(), [green('a'), green('b'), green('c')]),
    });
    // 'c' has no route; the HQ leg and 'a' resolve fine.
    d.travelProvider = {
      routingKey: () => 'stub:v1',
      distances: (origins: readonly string[]) =>
        Promise.resolve(
          origins.map((o) =>
            o === 'Adres c'
              ? { status: 'not_found' as const }
              : { status: 'ok' as const, leg: { distanceKm: 10, durationMinutes: 20 } }
          )
        ),
    };
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    const reasons = r.excluded.map((e) => `${e.externalItemId}:${e.reason}`);
    expect(reasons).toContain('b:no_rate');
    expect(reasons.some((x) => x.startsWith('c:'))).toBe(true);
  });

  it('a trainer-scoped override on the Monday item id is priced, not excluded', async () => {
    const override: RateCard = {
      rateKey: 'persoonlijk',
      trainerId: 'a',
      validFrom: '2000-01-01',
      validUntil: null,
      hourlyRateCents: 9900,
    };
    const { deps: d } = deps({
      roster: [trainer('a', { rateKey: 'persoonlijk' })],
      config: { ...CONFIG, rateCards: [override] },
    });
    const r = await runRecommendation(d, 'tr1');
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.recommendations[0].hourlyRateCents).toBe(9900);
    expect(r.excluded).toHaveLength(0);
  });
});
