import { describe, expect, it } from 'vitest';

import { THEMAS_BOARD, TRAINERS_BOARD } from '@lib/monday/board-config';
import { agendaTrainerRelations, reportAgendaBoards } from '@lib/report/agenda-boards';

import { SIGNAL_COLUMNS } from '../columns';
import { LABEL_CODES } from '@lib/labels';

import { readAgendaUsage, readLabelsForCheck, readSignals, readThemas } from '../read';

import type { BoardMeta, MondayGraphQLClient } from '@lib/monday/graphql-client';

type Col = BoardMeta['columns'][number];

const col = (id: string, type: string, settings: string | null = null): Col => ({
  id,
  title: id,
  type,
  settings_str: settings,
});

const agenda = reportAgendaBoards();
const themaRelation = agenda[0]?.themaRelation ?? '';

/** Wat elk bord moet hebben om door de keuring te komen. */
const healthy = (boardId: string): Col[] => {
  if (boardId === THEMAS_BOARD) {
    return [col('itg_conceptinhoud', 'long_text')];
  }
  const relatie = agenda.find((b) => b.boardId === boardId)?.themaRelation;
  if (relatie !== undefined) {
    const trainers = agendaTrainerRelations(boardId);
    const trainerCols =
      trainers === null
        ? []
        : trainers.co === null
          ? [trainers.lead]
          : [trainers.lead, trainers.co];
    return [
      col('status23', 'status'),
      col(relatie, 'board_relation', `{"boardIds":[${THEMAS_BOARD}]}`),
      ...trainerCols.map((id) => col(id, 'board_relation', `{"boardIds":[${TRAINERS_BOARD}]}`)),
    ];
  }
  return [
    col(SIGNAL_COLUMNS.tijdstip, 'date'),
    col(SIGNAL_COLUMNS.soort, 'status'),
    col(SIGNAL_COLUMNS.onderdeel, 'text'),
    col(SIGNAL_COLUMNS.detail, 'long_text'),
    col(SIGNAL_COLUMNS.afgehandeld, 'checkbox'),
    col(SIGNAL_COLUMNS.sleutel, 'text'),
    col(SIGNAL_COLUMNS.afgehandeldDoor, 'text'),
  ];
};

interface FakeOptions {
  /** Vervangt de kolommen van dit bord door iets kapots. */
  readonly columnsFor?: (boardId: string) => Col[];
  readonly items?: readonly unknown[];
}

function fakeClient(options: FakeOptions = {}): MondayGraphQLClient {
  const columnsFor = options.columnsFor ?? healthy;
  return {
    query: async () => {
      throw new Error('niet gebruikt');
    },
    preflight: async () => {
      throw new Error('niet gebruikt');
    },
    getSchema: async (ids: string[]) =>
      ids.map((id) => ({
        id,
        name: `bord ${id}`,
        groups: [],
        columns: columnsFor(id),
        items_count: 1,
      })),
    fetchBoardItems: async <T>(): Promise<T[]> => (options.items ?? []) as T[],
    lastReportedVersion: () => null,
  };
}

/** Eén kolom weglaten, precies zoals Monday doet als iemand hem verwijdert. */
const without = (id: string) => (boardId: string) => healthy(boardId).filter((c) => c.id !== id);

describe('readSignals — keuring van het Systeem-bord', () => {
  /**
   * Zonder deze keuring komt élke rij terug met een lege sleutel, ziet de run geen enkele
   * bestaande melding, en maakt hij het hele bord nog een keer aan — tot en met een tweede
   * samenvattingsrij.
   */
  it('weigert als de sleutelkolom weg is', async () => {
    await expect(
      readSignals(fakeClient({ columnsFor: without(SIGNAL_COLUMNS.sleutel) }), 'b1')
    ).rejects.toThrow(/schema drift.*itg_sleutel/s);
  });

  it('weigert als de vinkkolom van type is veranderd', async () => {
    const columnsFor = (boardId: string) =>
      healthy(boardId).map((c) => (c.id === SIGNAL_COLUMNS.afgehandeld ? col(c.id, 'text') : c));
    await expect(readSignals(fakeClient({ columnsFor }), 'b1')).rejects.toThrow(/itg_afgehandeld/);
  });

  it('leest een gezond bord gewoon', async () => {
    await expect(readSignals(fakeClient(), 'b1')).resolves.toEqual([]);
  });
});

describe('readAgendaUsage — keuring van de agenda', () => {
  /**
   * De giftigste variant. Verdwijnt de labelkolom, dan leest élk label als leeg, worden er nul
   * labelvondsten gedaan, en vinkt de opruimstap alle openstaande labelmeldingen af — terwijl
   * de controle "geslaagd" heet.
   */
  it('weigert als de labelkolom weg is', async () => {
    await expect(readAgendaUsage(fakeClient({ columnsFor: without('status23') }))).rejects.toThrow(
      /schema drift.*status23/s
    );
  });

  it('weigert als de themarelatie naar een ander bord is omgehangen', async () => {
    // Id en type blijven gelijk; alleen het doelbord verschuift. Zonder de settings-controle
    // levert dat geen fout op maar een lege relatie — "geen thema bij deze training".
    const columnsFor = (boardId: string) =>
      healthy(boardId).map((c) =>
        c.type === 'board_relation' ? col(c.id, 'board_relation', '{"boardIds":[999]}') : c
      );
    await expect(readAgendaUsage(fakeClient({ columnsFor }))).rejects.toThrow(
      /repointed|re-sourced/
    );
  });

  it('leest een gezonde agenda gewoon', async () => {
    const usage = await readAgendaUsage(fakeClient());
    expect(usage.labels.size).toBe(0);
    expect(themaRelation).not.toBe('');
  });
});

describe("readThemas — keuring van het Thema's-bord", () => {
  /**
   * Het omgekeerde gevaar: zonder de concept-kolom lijkt élk gebruikt thema leeg, en komen er
   * in één nacht negenentachtig meldingen bij.
   */
  it('weigert als de concept-kolom weg is', async () => {
    await expect(
      readThemas(fakeClient({ columnsFor: without('itg_conceptinhoud') }))
    ).rejects.toThrow(/schema drift.*itg_conceptinhoud/s);
  });

  it('weigert als de concept-kolom een gewone tekstkolom is geworden', async () => {
    // `text` kapt af bij een lange waarde, dus dit is niet alleen een typedetail: de bullets
    // zouden half gelezen worden.
    const columnsFor = () => [col('itg_conceptinhoud', 'text')];
    await expect(readThemas(fakeClient({ columnsFor }))).rejects.toThrow(/long_text/);
  });
});

describe('readLabelsForCheck', () => {
  const labelRow = (code: string, kleur = '#0A2B58') => ({
    id: `i-${code}`,
    name: code,
    column_values: [
      { id: 'itg_volledige_naam', text: `Naam ${code}` },
      { id: 'itg_kleur', text: kleur },
      { id: 'itg_term', text: 'Training' },
      { id: 'itg_rapportterm', text: 'de training' },
    ],
  });
  const labelClient = (items: ReturnType<typeof labelRow>[]) => ({
    query: async () => ({ boards: [{ items_page: { items } }] }),
  });
  const alle = LABEL_CODES.map((c) => labelRow(c));

  /**
   * De regressietest voor de fout die deze functie bestaansrecht geeft: met `readLabels` werpt
   * de bron juist wanneer er iets te melden valt, en valt de hele labelcontrole om — inclusief
   * de meldingen over onbekende labels, die met het Labels-bord niets te maken hebben.
   */
  it('levert een kaart op ook als er een rij ONTBREEKT', async () => {
    const zonderCP = alle.filter((r) => r.name !== 'CP');
    const map = await readLabelsForCheck(labelClient(zonderCP), 'b1');
    expect(map.size).toBe(LABEL_CODES.length - 1);
    expect(map.has('CP')).toBe(false);
  });

  it('levert een kaart op ook als een verplicht veld LEEG is', async () => {
    const metLegeKleur = alle.map((r) => (r.name === 'IT' ? labelRow('IT', '') : r));
    const map = await readLabelsForCheck(labelClient(metLegeKleur), 'b1');
    expect(map.size).toBe(LABEL_CODES.length);
    expect(map.get('IT')?.kleur).toBe('');
  });

  it('werpt nog steeds bij een structureel probleem', async () => {
    await expect(readLabelsForCheck(labelClient([...alle, labelRow('IT')]), 'b1')).rejects.toThrow(
      /niet eenduidig/
    );
  });
});
