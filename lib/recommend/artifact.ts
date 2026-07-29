import { createHash } from 'node:crypto';

import type { Qualification, RateCard, TravelTimeConfig } from '@lib/calc';

import type { EffectiveQualification } from './types';

/**
 * The immutable, PII-MINIMIZED input artifact stored on each run. Reproducibility
 * scope: it makes the DETERMINISTIC stages (eligibility, pricing, ranking) exactly
 * replayable; the external AI/Routes calls are audited (outputs recorded), not
 * re-executed. Raw addresses are EXCLUDED by construction — the type has no field
 * for a raw `locatie` or trainer address, only keyed fingerprints + Routes outputs.
 */

/** An audited Routes result, keyed by an address FINGERPRINT (never the raw string). */
export interface ArtifactRoute {
  originFingerprint: string;
  destinationFingerprint: string;
  routingKey: string;
  condition: string; // ROUTE_EXISTS | ROUTE_NOT_FOUND
  oneWayDistanceKm: number | null;
  oneWayDurationMinutes: number | null;
}

export interface InputArtifact {
  /**
   * v1 → v2 added `trainers[].id`. The bump is load-bearing, not cosmetic: a v1
   * artifact records only the Monday external id, so its pricing stage is NOT
   * replayable (trainer-scoped rate overrides are unmatchable). Any future replay
   * tool must refuse to re-price a v1 artifact rather than silently falling back
   * to the rateKey default.
   */
  version: 2;
  code: { gitSha: string | null; calcVersion: string };
  training: {
    externalItemId: string;
    datum: string | null;
    duurTraining: number | null;
    themeExternalIds: string[];
    // Raw `locatie` (destination address) is deliberately EXCLUDED.
  };
  qualifications: {
    observations: Array<{
      trainerExternalId: string;
      themaExternalId: string;
      colour: Qualification;
    }>;
    effective: Array<{
      trainerExternalId: string;
      themaExternalId: string;
      effective: EffectiveQualification | null;
      conflicted: boolean;
    }>;
    ackVersion: string | null;
  };
  trainers: Array<{
    /**
     * Internal DB uuid. REQUIRED for replay: pricing resolves the rate via
     * `tryResolveHourlyRateCents(rateCards, rateKey, id, date)`, and
     * `rate_cards.trainer_id` is a uuid — with only `externalItemId` a replay
     * cannot tell which trainer-scoped override applied once the trainer row
     * changes or is deleted. Not a new PII class: `rates.rateCards` below
     * already carries these same uuids.
     */
    id: string;
    externalItemId: string;
    mondayGroup: string | null;
    rateKey: string | null;
    // No `adres` / contact fields.
  }>;
  scores: Array<{
    trainerExternalId: string;
    themeAvgScore: number | null;
    overallAvgScore: number;
  }>;
  rates: {
    inputSyncRunId: string | null;
    rateCards: RateCard[];
    travelTimeConfig: TravelTimeConfig;
    trainerTravelRateCentsPerKm: number;
    clientTravelRateCentsPerKm: number;
  };
  enrichment: {
    // Audited (not re-executed): decision kind + model, never the raw address string.
    addressDecisionKind: string;
    addressReason: string | null;
    model: string | null;
    promptVersion: string | null;
    routingProfile: string;
    routes: ArtifactRoute[];
  };
}

/** Recursively sort object keys so serialization is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value).sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    )) {
      out[key] = canonicalize(val);
    }
    return out;
  }
  return value;
}

/** Canonical JSON: stable key order, so equal artifacts serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** sha256 of the canonical serialization — stable under key reordering. */
export function hashArtifact(artifact: InputArtifact): string {
  return createHash('sha256').update(canonicalJson(artifact)).digest('hex');
}
