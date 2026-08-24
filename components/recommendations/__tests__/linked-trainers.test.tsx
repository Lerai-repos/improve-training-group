import { describe, expect, it } from 'vitest';

import { AGENDA_2026_COLUMNS } from '@lib/monday/board-config';

import { readInvolvedTrainers, readLeadTrainers } from '../linked-trainers';

import type { MondayBridge } from '../monday-client';

/**
 * `readLeadTrainers` voedt de append in `pick-trainer`: die leest de huidige lijst, telt
 * de gekozen trainer erbij op en schrijft de vereniging terug naar dezelfde kolom.
 *
 * Daarom is deze lezer als enige in de codebase **bewust leadkolom-only**, terwijl de
 * decoder, de agendascan, de evaluatiehistorie en de briefing sinds 21-Aug-2026 juist
 * allemaal beide kolommen lezen. Zou hij meegaan in die verandering, dan verhuist elke
 * co-trainer bij de eerstvolgende keuze naar de leadkolom — een schrijfactie die niemand
 * heeft gevraagd, die de rolverdeling wist, en die er op het bord uitziet alsof iemand het
 * met de hand heeft gedaan.
 */
function bridge(
  reply: unknown,
  seen: { columnIds?: unknown; ids?: unknown } = {}
): MondayBridge {
  return {
    context: () => Promise.reject(new Error('niet gebruikt in deze test')),
    onContextChange: () => () => undefined,
    sessionToken: () => Promise.reject(new Error('niet gebruikt in deze test')),
    api: (_query: string, variables?: Record<string, unknown>) => {
      seen.columnIds = variables?.columnIds;
      seen.ids = variables?.ids;
      return Promise.resolve(reply);
    },
  };
}

const relation = (ids: string[], co: string[] = []): unknown => ({
  items: [
    {
      id: '1',
      column_values: [
        { id: AGENDA_2026_COLUMNS.trainerRelation, linked_item_ids: ids },
        { id: AGENDA_2026_COLUMNS.coTrainerRelation, linked_item_ids: co },
      ],
    },
  ],
});

describe('readLeadTrainers', () => {
  it('vraagt uitsluitend de leadkolom op', async () => {
    const seen: { columnIds?: unknown } = {};
    await readLeadTrainers(bridge(relation(['500']), seen), '1');
    expect(seen.columnIds).toEqual([AGENDA_2026_COLUMNS.trainerRelation]);
  });

  /**
   * De regressietest die hoort bij het commentaar hierboven: zodra iemand hier
   * `itg_cotrainers` bij zet, valt dit om.
   */
  it('vraagt de co-trainerkolom NIET op, want de append schrijft terug', async () => {
    const seen: { columnIds?: unknown } = {};
    await readLeadTrainers(bridge(relation(['500']), seen), '1');
    expect(seen.columnIds).not.toContain(AGENDA_2026_COLUMNS.coTrainerRelation);
  });

  it('geeft de gekoppelde ids terug als tekst', async () => {
    expect(await readLeadTrainers(bridge(relation(['500', '501'])), '1')).toEqual(['500', '501']);
  });
});

/**
 * De weergave-kant. Dit is de spiegelfout van hierboven: leest de lijst alleen de leadkolom,
 * dan staat een co-trainer als kiesbaar in de popup en levert één klik een tweede koppeling
 * op — nu ook als lead.
 */
describe('readInvolvedTrainers', () => {
  it('vraagt beide trainerkolommen op', async () => {
    const seen: { columnIds?: unknown } = {};
    await readInvolvedTrainers(bridge(relation(['500'], ['501']), seen), '1');
    expect(seen.columnIds).toEqual([
      AGENDA_2026_COLUMNS.trainerRelation,
      AGENDA_2026_COLUMNS.coTrainerRelation,
    ]);
  });

  it('geeft de co-trainers terug, achter de lead', async () => {
    expect(await readInvolvedTrainers(bridge(relation(['500'], ['501'])), '1')).toEqual([
      '500',
      '501',
    ]);
  });

  it('telt iemand die in beide kolommen staat één keer', async () => {
    expect(await readInvolvedTrainers(bridge(relation(['500'], ['500'])), '1')).toEqual(['500']);
  });
});
