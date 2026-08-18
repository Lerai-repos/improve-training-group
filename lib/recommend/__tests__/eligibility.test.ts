import { describe, expect, it } from 'vitest';

import { EMPTY_ACK, type Acknowledgements } from '@lib/monday';

import { NO_OVERRIDE } from '@lib/trainers/uurtarief';

import { computeEffectiveQuals, filterEligible } from '../eligibility';
import type { CandidateTrainer, QualObservation } from '../types';

const trainer = (ext: string): CandidateTrainer => ({
  externalItemId: ext,
  naam: `T${ext}`,
  adres: 'Somewhere 1',
  mondayGroup: 'topics',
  rateKey: '2020-2024',
  rateOverride: NO_OVERRIDE,
});

const obs = (t: string, th: string, colour: QualObservation['colour']): QualObservation => ({
  trainerExternalId: t,
  themaExternalId: th,
  colour,
});

describe('computeEffectiveQuals', () => {
  it('maps unambiguous colours: groen→green, rood→red, oranje/grijs→null', () => {
    const quals = computeEffectiveQuals(
      [
        obs('t1', 'th1', 'groen'),
        obs('t2', 'th1', 'rood'),
        obs('t3', 'th1', 'oranje'),
        obs('t4', 'th1', 'grijs'),
      ],
      EMPTY_ACK
    );
    const by = new Map(quals.map((q) => [q.trainerExternalId, q.effective]));
    expect(by.get('t1')).toBe('green');
    expect(by.get('t2')).toBe('red');
    expect(by.get('t3')).toBeNull();
    expect(by.get('t4')).toBeNull();
  });

  it('a conflict (groen+oranje) is NOT auto-green — effective NULL without an ack', () => {
    const quals = computeEffectiveQuals(
      [obs('t1', 'th1', 'groen'), obs('t1', 'th1', 'oranje')],
      EMPTY_ACK
    );
    expect(quals[0].conflicted).toBe(true);
    expect(quals[0].effective).toBeNull();
  });

  it('resolves a conflict only when the acknowledged colour set matches exactly', () => {
    const observations = [obs('t1', 'th1', 'groen'), obs('t1', 'th1', 'rood')];
    const stale: Acknowledgements = {
      ...EMPTY_ACK,
      qualConflicts: { 't1::th1': { colours: ['groen', 'oranje'], effective: 'green' } },
    };
    expect(computeEffectiveQuals(observations, stale)[0].effective).toBeNull();

    const ack: Acknowledgements = {
      ...EMPTY_ACK,
      qualConflicts: { 't1::th1': { colours: ['rood', 'groen'], effective: 'green' } },
    };
    expect(computeEffectiveQuals(observations, ack)[0].effective).toBe('green');
  });
});

describe('filterEligible', () => {
  const themes = ['th1', 'th2'];

  it('includes a trainer effective-green for EVERY theme', () => {
    const quals = computeEffectiveQuals(
      [obs('t1', 'th1', 'groen'), obs('t1', 'th2', 'groen')],
      EMPTY_ACK
    );
    expect(filterEligible(themes, [trainer('t1')], quals).map((t) => t.externalItemId)).toEqual([
      't1',
    ]);
  });

  it('excludes a trainer green for only some themes', () => {
    const quals = computeEffectiveQuals([obs('t1', 'th1', 'groen')], EMPTY_ACK);
    expect(filterEligible(themes, [trainer('t1')], quals)).toHaveLength(0);
  });

  it('excludes a trainer red or unresolved for any theme', () => {
    const quals = computeEffectiveQuals(
      [obs('t1', 'th1', 'groen'), obs('t1', 'th2', 'rood')],
      EMPTY_ACK
    );
    expect(filterEligible(themes, [trainer('t1')], quals)).toHaveLength(0);
  });

  it('zero themes → no eligible trainers', () => {
    const quals = computeEffectiveQuals([obs('t1', 'th1', 'groen')], EMPTY_ACK);
    expect(filterEligible([], [trainer('t1')], quals)).toHaveLength(0);
  });
});
