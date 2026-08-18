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
   * v2 → v3 REMOVED `trainers[].id` (the internal DB uuid) now that Monday is the
   * source of truth and the Monday item id is the trainer's identity. Pricing is
   * still fully replayable — `RateCard.trainerId` now matches that same item id.
   *
   * The bump stays load-bearing: a v2 artifact's `rates.rateCards[].trainerId`
   * holds uuids that no longer resolve to anything, so a replay tool must REFUSE a
   * v2 artifact rather than silently falling back to the rateKey default and
   * reporting a rate the run never used.
   *
   * v3 → v4 ADDED `trainers[].uurtarief`, the per-trainer rate override from the
   * Trainers board. Load-bearing for exactly the same reason: the field is omitted
   * when nobody set one, so on a v3 artifact its absence means UNKNOWN rather than
   * "no override" — and a replay that read it as "no override" would confidently
   * report the cohort rate for a run that billed something else entirely.
   */
  version: 4;
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
     * The Monday item id. Together with {@link uurtarief} this is everything pricing
     * consumed: a cohort rate resolves via
     * `tryResolveHourlyRateCents(rateCards, rateKey, externalItemId, date)`, where
     * `RateCard.trainerId` is that same id.
     */
    externalItemId: string;
    mondayGroup: string | null;
    rateKey: string | null;
    /**
     * The trainer's own `Uurtarief` cell, and the reason it is here: it OVERRIDES the
     * cohort, so without it two runs that billed different amounts would produce the
     * same artifact and the same hash.
     *
     * OMITTED when nobody set one, which is the overwhelmingly common case and keeps
     * every artifact recorded before this field existed byte-identical. `invalid`
     * carries the raw cell but deliberately not the human-readable reason — rewording
     * a message must never change an artifact hash.
     */
    uurtarief?: { kind: 'cents'; cents: number } | { kind: 'invalid'; raw: string };
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
