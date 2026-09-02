import { describe, expect, it, vi } from 'vitest';

import { BRIEFING_AGENDA_COLUMNS } from '@lib/briefing/columns';
import { readTrainingForReport } from '../training';

const C = BRIEFING_AGENDA_COLUMNS;
const AGENDA_2026 = '5087396949';
const AGENDA_2025 = '1703587792';

/** Gemeten 2-Sep-2026; 2025 gebruikt een ANDER id en heeft geen co-trainerkolom. */
const LEAD_2026 = 'board_relation_mkz4y7tb';
const LEAD_2025 = 'board_relation_mkz4w78';

interface Cell {
  id: string;
  text?: string | null;
  linked_items?: Array<{ id: string; name: string }> | null;
}

interface TestItem {
  id: string;
  name: string;
  board?: { id: string } | null;
  column_values?: Cell[] | null;
}

/** De parameters staan er expliciet op, anders typeert vitest `mock.calls` als lege tuples. */
const clientFor = (item: TestItem | null) => ({
  query: vi.fn(async (_query: string, _variables?: Record<string, unknown>) => ({
    items: item === null ? [] : [item],
  })),
});

const item = (boardId: string, cells: Cell[], name = 'Item-naam'): TestItem => ({
  id: 'i1',
  name,
  board: { id: boardId },
  column_values: [
    { id: C.klanttitel, text: 'Onderhandelen' },
    { id: C.contactpersoonNaam, text: 'Lisa de Vries' },
    { id: C.label, text: 'IT' },
    { id: C.ieCode, text: '251050' },
    ...cells,
  ],
});

/** Zet één kolomwaarde om, zonder aan de nullable `column_values` te hoeven denken. */
const withCell = (base: TestItem, id: string, text: string): TestItem => ({
  ...base,
  column_values: (base.column_values ?? []).map((c) => (c.id === id ? { ...c, text } : c)),
});

/**
 * Het item-id wordt van de NAAM afgeleid, niet van de positie in de kolom.
 *
 * Met een teller per aanroep kreeg de eerste trainer in beide kolommen id `t0`, en dan
 * ontdubbelt de lezer twee verschillende mensen tot één — een testfout die zich voordeed als
 * een codefout.
 */
const linked = (id: string, ...names: string[]): Cell => ({
  id,
  linked_items: names.map((name) => ({ id: `t:${name}`, name })),
});

describe('readTrainingForReport', () => {
  it('leest de gewone velden', async () => {
    const t = await readTrainingForReport(clientFor(item(AGENDA_2026, [])), 'i1');
    expect(t).toMatchObject({
      klanttitel: 'Onderhandelen',
      contactPersoon: 'Lisa de Vries',
      labelCode: 'IT',
      rawIeCode: '251050',
    });
  });

  it('gebruikt de itemnaam als de klanttitelkolom leeg is', async () => {
    const raw = withCell(item(AGENDA_2026, [], 'WE Fashion'), C.klanttitel, '');
    const t = await readTrainingForReport(clientFor(raw), 'i1');
    // De titel loopt middenin een zin naar de klant; leeg laten is geen optie.
    expect(t?.klanttitel).toBe('WE Fashion');
  });

  it('leest lead en co-trainer op het 2026-bord, lead eerst', async () => {
    const t = await readTrainingForReport(
      clientFor(
        item(AGENDA_2026, [
          linked(LEAD_2026, 'Kenneth Plat'),
          linked(C.coTrainerRelation, 'Jeanet Mosselman'),
        ])
      ),
      'i1'
    );
    expect(t?.trainerNamen).toEqual(['Kenneth Plat', 'Jeanet Mosselman']);
  });

  /**
   * DE regressie die dit bestand rechtvaardigt. Het 2025-bord draagt de trainers in een
   * ANDER kolom-id, en Monday geeft voor een onbekend id geen fout maar een LEGE relatie —
   * dus stond er "onze trainer" zonder naam in een rapport dat er verder normaal uitzag.
   */
  it('leest de trainer op het 2025-bord uit het andere kolom-id', async () => {
    const t = await readTrainingForReport(
      clientFor(item(AGENDA_2025, [linked(LEAD_2025, 'Mark de Vries')])),
      'i1'
    );
    expect(t?.trainerNamen).toEqual(['Mark de Vries']);
  });

  /** Op 2025 bestaat `itg_cotrainers` niet; wat daar toevallig in zou staan telt niet mee. */
  it('negeert de 2026-kolommen op een 2025-item', async () => {
    const t = await readTrainingForReport(
      clientFor(
        item(AGENDA_2025, [linked(LEAD_2025, 'Mark de Vries'), linked(LEAD_2026, 'Iemand Anders')])
      ),
      'i1'
    );
    expect(t?.trainerNamen).toEqual(['Mark de Vries']);
  });

  /**
   * Dezelfde persoon kan in beide kolommen staan. Zonder ontdubbeling staat er "onze
   * trainers Jan en Jan" in een brief aan een klant, mét het meervoud.
   * `lib/briefing/read.ts` filtert hier al op; dit doet hetzelfde.
   */
  it('ontdubbelt een trainer die in beide kolommen staat', async () => {
    const t = await readTrainingForReport(
      clientFor(
        item(AGENDA_2026, [
          { id: LEAD_2026, linked_items: [{ id: 't1', name: 'Jan Bakker' }] },
          {
            id: C.coTrainerRelation,
            linked_items: [
              { id: 't1', name: 'Jan Bakker' },
              { id: 't2', name: 'Piet Jansen' },
            ],
          },
        ])
      ),
      'i1'
    );
    expect(t?.trainerNamen).toEqual(['Jan Bakker', 'Piet Jansen']);
  });

  /** Op ID ontdubbelen, niet op naam: twee mensen mogen dezelfde naam hebben. */
  it('houdt twee verschillende trainers met dezelfde naam apart', async () => {
    const t = await readTrainingForReport(
      clientFor(
        item(AGENDA_2026, [
          {
            id: LEAD_2026,
            linked_items: [
              { id: 't1', name: 'Jan Bakker' },
              { id: 't2', name: 'Jan Bakker' },
            ],
          },
        ])
      ),
      'i1'
    );
    expect(t?.trainerNamen).toEqual(['Jan Bakker', 'Jan Bakker']);
  });

  it('werpt op een agendabord dat we niet kennen, in plaats van 2026 te gokken', async () => {
    await expect(
      readTrainingForReport(clientFor(item('999999', [linked(LEAD_2026, 'Jan')])), 'i1')
    ).rejects.toThrow('welke kolom de trainers draagt');
  });

  it('lost een labelalias op en meldt een onbekend label als null', async () => {
    const alias = withCell(item(AGENDA_2026, []), C.label, 'WorkJoy');
    expect((await readTrainingForReport(clientFor(alias), 'i1'))?.labelCode).toBe('WJ');

    const onbekend = withCell(item(AGENDA_2026, []), C.label, 'TMT');
    const t = await readTrainingForReport(clientFor(onbekend), 'i1');
    expect(t?.labelCode).toBeNull();
    expect(t?.rawLabel).toBe('TMT');
  });

  it('geeft null als het item niet bestaat', async () => {
    expect(await readTrainingForReport(clientFor(null), 'i1')).toBeNull();
  });

  /** Eén projectie over beide jaargangen; een tweede bordbevraging is niet nodig. */
  it('vraagt alle bekende trainerrelaties in één query op', async () => {
    const client = clientFor(item(AGENDA_2026, []));
    await readTrainingForReport(client, 'i1');
    const query = String(client.query.mock.calls[0]?.[0] ?? '');
    expect(query).toContain(LEAD_2026);
    expect(query).toContain(LEAD_2025);
    expect(query).toContain('board { id }');
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
