import { describe, expect, it } from 'vitest';

import {
  deriveTrainerGroupReadiness,
  snapshotProblem,
  unusableSelections,
  type TrainerGroupCounts,
} from '../trainer-groups';

const counts = (
  over: Partial<TrainerGroupCounts> & { mondayGroup: string }
): TrainerGroupCounts => ({
  trainers: 0,
  greenTrainers: 0,
  greenWithResolvableRate: 0,
  greenWithoutRate: 0,
  ...over,
});

const board = [
  { id: 'topics', title: 'Trainers instroom 2020-2024' },
  { id: 'schaduw', title: 'Schaduwpool' },
  { id: 'inactief', title: 'Inactief/uit dienst' },
  { id: 'half', title: 'Half ingericht' },
];

describe('deriveTrainerGroupReadiness', () => {
  it('ready only when EVERY green trainer is priceable', () => {
    const [row] = deriveTrainerGroupReadiness({
      mondayGroups: [{ id: 'topics', title: 'T' }],
      counts: [
        counts({
          mondayGroup: 'topics',
          trainers: 18,
          greenTrainers: 12,
          greenWithResolvableRate: 12,
        }),
      ],
      selected: ['topics'],
    });
    expect(row.status).toBe('ready');
    expect(row.selected).toBe(true);
  });

  it('partial when some green trainers lack a resolvable rate', () => {
    const [row] = deriveTrainerGroupReadiness({
      mondayGroups: [{ id: 'half', title: 'Half' }],
      counts: [
        counts({
          mondayGroup: 'half',
          trainers: 10,
          greenTrainers: 6,
          greenWithResolvableRate: 4,
          greenWithoutRate: 2,
        }),
      ],
      selected: [],
    });
    expect(row.status).toBe('partial');
  });

  it('NOT ready when one trainer has a rate and a DIFFERENT one is green', () => {
    // The intersection trap: independent totals would call this ready.
    const [row] = deriveTrainerGroupReadiness({
      mondayGroups: [{ id: 'inactief', title: 'Inactief' }],
      counts: [
        counts({
          mondayGroup: 'inactief',
          trainers: 25,
          greenTrainers: 4, // green people…
          greenWithResolvableRate: 0, // …but none of THEM can be priced
          greenWithoutRate: 4,
        }),
      ],
      selected: [],
    });
    expect(row.status).toBe('not_configured');
  });

  it('not_configured when nobody is green at all (Schaduwpool)', () => {
    const [row] = deriveTrainerGroupReadiness({
      mondayGroups: [{ id: 'schaduw', title: 'Schaduwpool' }],
      counts: [counts({ mondayGroup: 'schaduw', trainers: 28 })],
      selected: [],
    });
    expect(row.status).toBe('not_configured');
  });

  it('a selected id absent from the board is missing_from_monday, never dropped', () => {
    const rows = deriveTrainerGroupReadiness({
      mondayGroups: board,
      counts: [],
      selected: ['typo_group'],
    });
    const typo = rows.find((r) => r.id === 'typo_group');
    expect(typo).toBeDefined();
    expect(typo?.status).toBe('missing_from_monday');
    expect(typo?.title).toBeNull();
    expect(typo?.selected).toBe(true);
  });

  it('rows are the union of board, snapshot and selection', () => {
    const rows = deriveTrainerGroupReadiness({
      mondayGroups: [{ id: 'topics', title: 'T' }],
      counts: [counts({ mondayGroup: 'only_in_db', trainers: 3 })],
      selected: ['only_selected'],
    });
    expect(rows.map((r) => r.id).sort()).toEqual(['only_in_db', 'only_selected', 'topics']);
  });

  it('selected rows sort first', () => {
    const rows = deriveTrainerGroupReadiness({
      mondayGroups: board,
      counts: [counts({ mondayGroup: 'schaduw', trainers: 99 })],
      selected: ['topics'],
    });
    expect(rows[0].id).toBe('topics');
  });
});

describe('unusableSelections', () => {
  it('flags selected missing_from_monday and not_configured, but not partial', () => {
    const rows = deriveTrainerGroupReadiness({
      mondayGroups: board,
      counts: [
        counts({
          mondayGroup: 'topics',
          trainers: 5,
          greenTrainers: 5,
          greenWithResolvableRate: 5,
        }),
        counts({ mondayGroup: 'schaduw', trainers: 28 }),
        counts({
          mondayGroup: 'half',
          trainers: 4,
          greenTrainers: 3,
          greenWithResolvableRate: 2,
          greenWithoutRate: 1,
        }),
      ],
      selected: ['topics', 'schaduw', 'half', 'typo'],
    });
    expect(
      unusableSelections(rows)
        .map((r) => r.id)
        .sort()
    ).toEqual(['schaduw', 'typo']);
  });

  it('ignores unusable groups that are NOT selected', () => {
    const rows = deriveTrainerGroupReadiness({
      mondayGroups: board,
      counts: [counts({ mondayGroup: 'schaduw', trainers: 28 })],
      selected: [],
    });
    expect(unusableSelections(rows)).toHaveLength(0);
  });
});

describe('snapshotProblem', () => {
  const NOW = Date.parse('2026-07-28T12:00:00Z');
  const DAY = 24 * 3_600_000;

  it('rejects a missing snapshot', () => {
    const issue = snapshotProblem({ syncRunId: null, syncStartedAt: null }, DAY, NOW);
    expect(issue?.kind).toBe('no_sync');
    expect(issue?.message).toMatch(/no succ/i);
  });

  it('rejects a stale snapshot with its age', () => {
    const started = new Date(NOW - 3 * DAY).toISOString();
    const issue = snapshotProblem({ syncRunId: 'r1', syncStartedAt: started }, DAY, NOW);
    expect(issue?.kind).toBe('stale');
    expect(issue?.message).toMatch(/72h old/);
  });

  it('reports an unparseable timestamp as a DATA DEFECT, not as staleness', () => {
    // Would previously say "stale (NaNh old)" and send the operator to re-sync.
    const issue = snapshotProblem({ syncRunId: 'r1', syncStartedAt: 'not-a-date' }, DAY, NOW);
    expect(issue?.kind).toBe('invalid_timestamp');
    expect(issue?.message).not.toMatch(/NaN/);
    expect(issue?.message).toMatch(/unparseable/i);
  });

  it('accepts a fresh snapshot', () => {
    const started = new Date(NOW - 3_600_000).toISOString();
    expect(snapshotProblem({ syncRunId: 'r1', syncStartedAt: started }, DAY, NOW)).toBeNull();
  });

  it('accepts a snapshot exactly at the age limit (boundary is >, not >=)', () => {
    const started = new Date(NOW - DAY).toISOString();
    expect(snapshotProblem({ syncRunId: 'r1', syncStartedAt: started }, DAY, NOW)).toBeNull();
  });
});
