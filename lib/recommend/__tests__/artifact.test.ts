import { describe, expect, it } from 'vitest';

import { canonicalJson, hashArtifact, type InputArtifact } from '../artifact';
import { toTrainerTravel } from '../travel-enrich';

const artifact: InputArtifact = {
  version: 3,
  code: { gitSha: 'abc123', calcVersion: '1' },
  training: {
    externalItemId: 'tr-1',
    datum: '2026-02-10',
    duurTraining: 4,
    themeExternalIds: ['th1'],
  },
  qualifications: {
    observations: [{ trainerExternalId: 't1', themaExternalId: 'th1', colour: 'groen' }],
    effective: [
      { trainerExternalId: 't1', themaExternalId: 'th1', effective: 'green', conflicted: false },
    ],
    ackVersion: 'sha-ack',
  },
  trainers: [
    {
      externalItemId: 't1',
      mondayGroup: 'topics',
      rateKey: '2020-2024',
    },
  ],
  scores: [{ trainerExternalId: 't1', themeAvgScore: null, overallAvgScore: 0 }],
  rates: {
    inputSyncRunId: 'run-1',
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
  },
  enrichment: {
    addressDecisionKind: 'travel_required',
    addressReason: null,
    model: 'claude-haiku-4.5',
    promptVersion: 'v1',
    routingProfile: 'TRAFFIC_UNAWARE',
    routes: [
      {
        originFingerprint: 'fp-origin',
        destinationFingerprint: 'fp-dest',
        routingKey: 'routes:TRAFFIC_UNAWARE:v1',
        condition: 'ROUTE_EXISTS',
        oneWayDistanceKm: 10,
        oneWayDurationMinutes: 30,
      },
    ],
  },
};

describe('canonicalJson / hashArtifact', () => {
  it('is stable under key reordering', () => {
    const reordered = { code: artifact.code, version: artifact.version };
    const straight = { version: artifact.version, code: artifact.code };
    expect(canonicalJson(reordered)).toBe(canonicalJson(straight));
  });

  it('hashArtifact is order-independent for equal content', () => {
    // Rebuild the artifact with keys inserted in a different order.
    const shuffled: InputArtifact = {
      enrichment: artifact.enrichment,
      rates: artifact.rates,
      scores: artifact.scores,
      trainers: artifact.trainers,
      qualifications: artifact.qualifications,
      training: artifact.training,
      code: artifact.code,
      version: 3,
    };
    expect(hashArtifact(shuffled)).toBe(hashArtifact(artifact));
  });

  it('a content change changes the hash', () => {
    const changed: InputArtifact = { ...artifact, code: { gitSha: 'different', calcVersion: '1' } };
    expect(hashArtifact(changed)).not.toBe(hashArtifact(artifact));
  });
});

describe('toTrainerTravel', () => {
  it('doubles one-way legs to round-trip exactly once', () => {
    expect(
      toTrainerTravel(
        { distanceKm: 10, durationMinutes: 30 },
        { distanceKm: 12, durationMinutes: 40 }
      )
    ).toEqual({
      roundTripDistanceKm: 20,
      hqRoundTripDistanceKm: 24,
      roundTripDurationMinutes: 60,
    });
  });
});
