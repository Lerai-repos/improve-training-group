import { describe, expect, it, vi } from 'vitest';

import { CATEGORIES, INITIAL_ROWS } from '../initial-rows';
import { resolveSetting } from '../keys';
import { readSettings, SETTINGS_EXPECTED_COLUMNS } from '../read';
import { REQUIRED_RATE_KEYS } from '../rates';
import { REQUIRED_APP_KEYS } from '../required';
import { buildSettingsSnapshot } from '../snapshot';

import type { BoardMeta, MondayGraphQLClient } from '@lib/monday/graphql-client';

/**
 * The board `instellingen:create` builds must satisfy the reader at its STRICTEST.
 *
 * This is the coupling that has already broken once. The creator is the only caller that
 * does not go through `loadSettingsOnce` / `createSettingsLoader` — it calls
 * `buildSettingsSnapshot` directly — so tightening the required set reaches every other
 * caller automatically and reaches this one not at all. A fresh board then comes out
 * incomplete, and nobody finds out until someone runs the command months later.
 */

const BOARD = '5102171946';
const NOTITIES = 'group_notities';
const SETTINGS = 'group_instellingen';
const GROEPEN = 'itg_groepen';

/** As the creator writes them, plus the row provisioning adds. */
function boardItems() {
  const rows = INITIAL_ROWS.map((row, i) => ({
    id: String(i + 1),
    name: row.name,
    updated_at: '2026-08-17T00:00:00Z',
    group: { id: SETTINGS },
    column_values: [
      { id: 'itg_waarde', text: row.waarde },
      { id: GROEPEN, text: '', values: [] as Array<{ id: string; label: string }> },
    ],
  }));
  rows.push({
    id: String(INITIAL_ROWS.length + 1),
    name: 'TRAINERGROEPEN',
    updated_at: '2026-08-17T00:00:00Z',
    group: { id: SETTINGS },
    column_values: [
      { id: 'itg_waarde', text: '' },
      {
        id: GROEPEN,
        text: 'x',
        values: [
          { id: '1', label: 'Topics — topics' },
          { id: '2', label: 'Nieuwe groep — nieuwe_groep__1' },
        ],
      },
    ],
  });
  return rows;
}

function creatorBoard(items = boardItems()): MondayGraphQLClient {
  const meta: BoardMeta = {
    id: BOARD,
    name: 'Instellingen',
    groups: [
      { id: SETTINGS, title: 'Instellingen' },
      { id: NOTITIES, title: 'Notities' },
    ],
    columns: [
      ...SETTINGS_EXPECTED_COLUMNS.map((c) => ({
        id: c.id,
        title: c.id,
        type: c.type,
        settings_str: null,
      })),
      { id: GROEPEN, title: 'Groepen', type: 'dropdown', settings_str: null },
    ],
    items_count: items.length,
  } as unknown as BoardMeta;

  return {
    query: vi.fn(async () => ({
      boards: [
        {
          columns: [
            {
              settings: {
                labels: [
                  { id: 1, label: 'Topics — topics' },
                  { id: 2, label: 'Nieuwe groep — nieuwe_groep__1' },
                ],
              },
            },
          ],
        },
      ],
    })),
    preflight: vi.fn(),
    getSchema: vi.fn(async () => [meta]),
    fetchBoardItems: vi.fn(async () => items),
    lastReportedVersion: () => null,
  } as unknown as MondayGraphQLClient;
}

const strict = {
  boardId: BOARD,
  isProduction: true,
  requireTrainerGroups: true,
  readAt: 1_760_000_000_000,
  env: {},
};

describe('INITIAL_ROWS', () => {
  /**
   * The direct statement of the contract: every key the reader demands has a row the
   * creator writes. Cheap, and it fails the moment somebody adds a required key without
   * adding the row that satisfies it.
   */
  it('covers every required app key', () => {
    const produced = new Set(
      INITIAL_ROWS.map((row) => resolveSetting(row.name, row.waarde)).flatMap((r) =>
        r.kind === 'app' ? [r.row.key] : []
      )
    );
    // TRAINERGROEPEN is the exception: provisioning adds it, not the row list.
    const fromRows = REQUIRED_APP_KEYS.filter((k) => k !== 'RECOMMENDABLE_TRAINER_GROUPS');

    expect(fromRows.filter((key) => !produced.has(key))).toEqual([]);
  });

  it('covers every required rate key', () => {
    const produced = new Set(
      INITIAL_ROWS.map((row) => resolveSetting(row.name, row.waarde)).flatMap((r) =>
        r.kind === 'rate' ? [r.rateKey] : []
      )
    );

    expect([...REQUIRED_RATE_KEYS].filter((key) => !produced.has(key))).toEqual([]);
  });

  it('uses only categories the board actually offers', () => {
    for (const row of INITIAL_ROWS) {
      expect(CATEGORIES).toContain(row.categorie);
    }
  });

  it('has no row the reader would reject as unknown', () => {
    for (const row of INITIAL_ROWS) {
      expect(resolveSetting(row.name, row.waarde).kind).not.toBe('unknown');
    }
  });
});

describe('a board built by instellingen:create', () => {
  /**
   * End to end, at the strictest setting the engine ever uses — production, with
   * `TRAINERGROEPEN` required. This is what `verifyReadable` asserts against a real
   * board; asserting it here means a change to the required set fails in CI rather than
   * the next time somebody creates a board.
   */
  it('is readable under the strict rules, in production', async () => {
    const raw = await readSettings(creatorBoard(), {
      boardId: BOARD,
      notitiesGroupId: NOTITIES,
      groepenOptions: new Map([
        ['1', 'topics'],
        ['2', 'nieuwe_groep__1'],
      ]),
    });

    const snapshot = buildSettingsSnapshot(raw, strict);

    expect(snapshot.app.hqAddress).toBe('Wolvenplein 25, Utrecht');
    expect(snapshot.app.travelRateTrainerCentsPerKm).toBe(23);
    expect(snapshot.app.recommendableTrainerGroups).toEqual(['topics', 'nieuwe_groep__1']);
    expect(snapshot.rateCards).toHaveLength(2);
  });

  /**
   * The negative half, so the test above cannot pass by accident. Drop any one of the
   * creator's rows and the strict reader must refuse — which is exactly what would
   * happen on a real board if `INITIAL_ROWS` fell behind `REQUIRED_APP_KEYS`.
   */
  it('is refused if any one of the creator’s rows is missing', async () => {
    for (const row of INITIAL_ROWS) {
      const without = boardItems().filter((i) => i.name !== row.name);
      const client = creatorBoard(without);

      await expect(
        readSettings(client, { boardId: BOARD, notitiesGroupId: NOTITIES }).then((raw) =>
          buildSettingsSnapshot(raw, strict)
        )
      ).rejects.toThrow();
    }
  });
});
