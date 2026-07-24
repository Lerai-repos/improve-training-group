import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KLANTEN,
  DEFAULT_QUALIFICATIONS,
  DEFAULT_THEMAS,
  DEFAULT_TRAINERS,
  DEFAULT_TRAININGS,
} from '@lib/monday/__fixtures__/domain';

import { buildArtifact, deriveEffective } from '../artifact';

describe('deriveEffective', () => {
  it('maps groen→green and rood→red', () => {
    expect(deriveEffective(['groen'])).toEqual({ effective: 'green', conflict_resolution: null });
    expect(deriveEffective(['rood'])).toEqual({ effective: 'red', conflict_resolution: null });
  });

  it('leaves oranje/grijs effective null (unconfirmed mapping)', () => {
    expect(deriveEffective(['oranje'])).toEqual({ effective: null, conflict_resolution: null });
    expect(deriveEffective(['grijs'])).toEqual({ effective: null, conflict_resolution: null });
  });

  it('records a conflict (multiple colours) and leaves effective null', () => {
    expect(deriveEffective(['groen', 'rood'])).toEqual({
      effective: null,
      conflict_resolution: { colours: ['groen', 'rood'] },
    });
  });
});

describe('buildArtifact', () => {
  const input = {
    boardId: '5087396949',
    trainers: DEFAULT_TRAINERS,
    themas: DEFAULT_THEMAS,
    klanten: DEFAULT_KLANTEN,
    trainings: DEFAULT_TRAININGS,
    qualifications: DEFAULT_QUALIFICATIONS,
  };

  it('counts equal the section lengths (the RPC re-verifies this)', () => {
    const a = buildArtifact(input);
    for (const key of Object.keys(a.counts)) {
      const section = a[key as keyof typeof a];
      expect(Array.isArray(section)).toBe(true);
      if (Array.isArray(section)) {
        expect(section.length).toBe(a.counts[key]);
      }
    }
  });

  it('dedupes masters by external id', () => {
    const dup = buildArtifact({ ...input, trainers: [...DEFAULT_TRAINERS, DEFAULT_TRAINERS[0]] });
    expect(dup.counts.trainers).toBe(2);
  });

  it('keeps a conflicting pair as two observations but one effective row', () => {
    const qualifications = [
      ...DEFAULT_QUALIFICATIONS,
      {
        trainerExternalId: '1661150001',
        themaExternalId: '5067920001',
        qualification: 'rood' as const,
      },
    ];
    const a = buildArtifact({ ...input, qualifications });
    expect(a.counts.qual_observations).toBe(5);
    expect(a.counts.qual_effective).toBe(4);
    const pair = a.qual_effective.find(
      (e) => e.trainer_ext === '1661150001' && e.thema_ext === '5067920001'
    );
    expect(pair?.effective).toBeNull();
  });
});
