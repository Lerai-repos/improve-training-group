import { describe, expect, it } from 'vitest';

import { GROUP_POLICY } from '@lib/monday/board-config';

import { cohortEuros, planTarief } from '../tarief-plan';

import type { RateCard } from '@lib/calc';
import type { TrainerRow } from '../tarief-plan';

const OLD_GROUP = 'topics';
const NEW_GROUP = 'nieuwe_groep__1';

const card = (over: Partial<RateCard> & { rateKey: string }): RateCard => ({
  trainerId: null,
  validFrom: '2020-01-01',
  validUntil: null,
  hourlyRateCents: 8800,
  ...over,
});

const CARDS: RateCard[] = [
  card({ rateKey: '2020-2024', hourlyRateCents: 8800 }),
  card({ rateKey: '2024-heden', hourlyRateCents: 8400 }),
];

const row = (over: Partial<TrainerRow> & { itemId: string }): TrainerRow => ({
  naam: `T${over.itemId}`,
  groupId: OLD_GROUP,
  groupTitle: 'Trainers instroom 2020-2024',
  uurtarief: null,
  ...over,
});

describe('cohortEuros', () => {
  it('derives the amount from the live cards, not from a constant', () => {
    const euros = cohortEuros(CARDS, '2026-08-18');
    expect(euros.get(OLD_GROUP)).toBe('88');
    expect(euros.get(NEW_GROUP)).toBe('84');
  });

  it('follows a changed board rate rather than the shipped default', () => {
    const raised = [
      card({ rateKey: '2020-2024', hourlyRateCents: 9500 }),
      card({ rateKey: '2024-heden', hourlyRateCents: 9000 }),
    ];
    const euros = cohortEuros(raised, '2026-08-18');
    expect(euros.get(OLD_GROUP)).toBe('95');
    expect(euros.get(NEW_GROUP)).toBe('90');
  });

  it('ignores a trainer-scoped card, so one person cannot set the cohort rate', () => {
    const withOverride = [
      ...CARDS,
      card({ rateKey: '2020-2024', trainerId: '999', hourlyRateCents: 20000 }),
    ];
    expect(cohortEuros(withOverride, '2026-08-18').get(OLD_GROUP)).toBe('88');
  });

  it('refuses when a cohort has no card covering that date', () => {
    const expiring = [
      card({ rateKey: '2020-2024', validUntil: '2026-01-01' }),
      card({ rateKey: '2024-heden', hourlyRateCents: 8400 }),
    ];
    expect(() => cohortEuros(expiring, '2026-08-18')).toThrow(/2020-2024/);
  });

  it('covers exactly the priceable groups in GROUP_POLICY', () => {
    const priceable = Object.entries(GROUP_POLICY)
      .filter(([, p]) => p.rateKey !== null)
      .map(([g]) => g);
    expect([...cohortEuros(CARDS, '2026-08-18').keys()].sort()).toEqual(priceable.sort());
  });
});

describe('planTarief', () => {
  const euros = cohortEuros(CARDS, '2026-08-18');

  it('writes the cohort amount for every empty cell in a cohort group', () => {
    const plan = planTarief(
      [
        row({ itemId: '1' }),
        row({ itemId: '2', groupId: NEW_GROUP, groupTitle: 'Trainers instroom 2024 - Heden' }),
      ],
      euros
    );
    expect(plan.writes).toEqual([
      expect.objectContaining({ itemId: '1', euros: '88', rateKey: '2020-2024' }),
      expect.objectContaining({ itemId: '2', euros: '84', rateKey: '2024-heden' }),
    ]);
  });

  it('never overwrites a filled cell, even when it matches the cohort', () => {
    const plan = planTarief(
      [row({ itemId: '1', uurtarief: '88' }), row({ itemId: '2', uurtarief: '125' })],
      euros
    );
    expect(plan.writes).toEqual([]);
    expect(plan.alreadySet.map((a) => a.current)).toEqual(['88', '125']);
  });

  it('treats a whitespace-only cell as empty', () => {
    expect(planTarief([row({ itemId: '1', uurtarief: '  ' })], euros).writes).toHaveLength(1);
  });

  it('leaves every non-cohort group alone and reports it grouped', () => {
    const plan = planTarief(
      [
        row({ itemId: '1', groupId: 'group_mm0d6p4r', groupTitle: 'Schaduwpool' }),
        row({ itemId: '2', groupId: 'group_mm0d6p4r', groupTitle: 'Schaduwpool' }),
        row({ itemId: '3', groupId: 'nieuwe_groep22164__1', groupTitle: 'Acteurs' }),
        row({ itemId: '4', groupId: null, groupTitle: '(zonder groep)' }),
      ],
      euros
    );
    expect(plan.writes).toEqual([]);
    expect(plan.noCohort).toEqual([
      { groupTitle: 'Schaduwpool', count: 2 },
      { groupTitle: 'Acteurs', count: 1 },
      { groupTitle: '(zonder groep)', count: 1 },
    ]);
  });

  it('is idempotent: a second pass over the written board plans nothing', () => {
    const rows = [row({ itemId: '1' }), row({ itemId: '2' })];
    const first = planTarief(rows, euros);
    const after = rows.map((r) => ({
      ...r,
      uurtarief: first.writes.find((w) => w.itemId === r.itemId)?.euros ?? null,
    }));
    expect(planTarief(after, euros).writes).toEqual([]);
  });
});
