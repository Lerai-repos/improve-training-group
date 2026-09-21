import { describe, expect, it } from 'vitest';

import { createMemoryCyclusStore } from '../cyclus-store';
import { resolveChecklistAnker, type AnkerReader } from '../cyclus-anker';

import type { AgendaBoard } from '@lib/evaluations';

/**
 * Waar een schrijfactie op de checklist landt, bepaald op de server bij het schrijven.
 *
 * De tab weet het anker van bij het laden; dit is wat er gebeurt als dat intussen niet meer
 * klopt.
 */

const bord = (boardId: string, gearchiveerd: boolean): AgendaBoard => ({
  boardId,
  naam: boardId,
  gearchiveerd,
  jaargang: boardId,
  trainerRelation: 't',
  themaRelation: 'th',
  klantRelation: 'k',
  ieCode: 'ie',
  datum: 'datum_1',
  minimumItems: 0,
  groupIds: [],
  columnTypes: {},
});

const BORDEN = [bord('2026', true), bord('2027', false)];

interface Item {
  readonly opp: string | null;
  readonly board: string;
  readonly datum: string;
}

function client(items: Record<string, Item>): AnkerReader {
  return {
    query<T>(document: string, variables?: Record<string, unknown>): Promise<T> {
      const ids = Array.isArray(variables?.ids) ? variables.ids.map(String) : [];
      const antwoord: unknown = {
        items: ids
          .filter((id) => items[id] !== undefined)
          .map((id) => ({
            id,
            board: { id: items[id].board },
            column_values: document.includes('linked_item_ids')
              ? [
                  {
                    id: 'board_relation',
                    linked_item_ids: items[id].opp === null ? [] : [items[id].opp],
                  },
                ]
              : [{ id: 'datum_1', date: items[id].datum }],
          })),
      };
      // Test-dubbel: precies de vorm die de twee queries verwachten.
      return Promise.resolve(antwoord as T);
    },
  };
}

const ITEMS: Record<string, Item> = {
  a: { opp: 'opp1', board: '2026', datum: '2026-12-01' },
  b: { opp: 'opp1', board: '2027', datum: '2027-01-10' },
  c: { opp: 'opp1', board: '2027', datum: '2027-02-10' },
  los: { opp: null, board: '2027', datum: '2027-03-01' },
};

describe('resolveChecklistAnker', () => {
  it('is het item zelf zonder Opportunity of zonder bevestigde groep', async () => {
    const cycli = createMemoryCyclusStore();
    expect((await resolveChecklistAnker(client(ITEMS), cycli, 'los')).anker).toBe('los');
    expect((await resolveChecklistAnker(client(ITEMS), cycli, 'c')).anker).toBe('c');
  });

  /** De tab laadde toen c nog los was; intussen is c bij [b, c] gevinkt. */
  it('volgt de bevestigde groep zoals die nu is', async () => {
    const cycli = createMemoryCyclusStore();
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['b', 'c'], anker: 'b' }],
      beslist: {},
      verhuizingen: [],
    }));
    expect((await resolveChecklistAnker(client(ITEMS), cycli, 'c')).anker).toBe('b');
  });

  /** Het anker komt uit het record, niet uit de datums: de lading heeft het al verplaatst. */
  it('volgt het vastgelegde anker, ook als de eerste sessie gearchiveerd is', async () => {
    const cycli = createMemoryCyclusStore();
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['a', 'b', 'c'], anker: 'b' }],
      beslist: {},
      verhuizingen: [],
    }));
    expect((await resolveChecklistAnker(client(ITEMS), cycli, 'c')).anker).toBe('b');
  });

  /**
   * Het hek is de versie van het cyclusrecord op het moment van bepalen. Verandert een collega
   * de cyclus daarna, dan mag de schrijfactie met dit hek niet meer doorgaan.
   */
  it('geeft het hek van de gelezen cyclusstand mee', async () => {
    const cycli = createMemoryCyclusStore();
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['b', 'c'], anker: 'b' }],
      beslist: {},
      verhuizingen: [],
    }));
    const eerst = await resolveChecklistAnker(client(ITEMS), cycli, 'c');

    await cycli.update('opp1', () => ({ groepen: [], beslist: {}, verhuizingen: [] }));
    const daarna = await resolveChecklistAnker(client(ITEMS), cycli, 'c');

    expect(eerst.fence?.key).toBe('briefing:cyclus:opp1');
    expect(eerst.fence?.token).not.toBe(daarna.fence?.token);
  });
});
