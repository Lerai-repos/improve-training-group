import { beoordeelAlle } from './beoordeel';
import { TEKST_COLUMNS } from './columns';
import { readTekstRijen } from './read';

import type { TekstRij } from './beoordeel';
import type { TekstenReader } from './read';
import type { TekstStatus } from './types';

/**
 * De kolommen Status en Melding bijhouden.
 *
 * Altijd het héle bord opnieuw keuren, ook als er maar één item veranderde: een dubbele
 * sleutel is pas te zien als je beide items kent, en het tweede item wordt daar niet anders
 * van. Het bord heeft ~23 items, dus dat kost één query.
 */

export interface StatusWijziging {
  readonly itemId: string;
  readonly naam: string;
  readonly status: TekstStatus;
  readonly melding: string;
}

/** Alleen de items waarvan Status of Melding niet klopt; de rest laten we met rust. */
export function statusWijzigingen(rijen: readonly TekstRij[]): readonly StatusWijziging[] {
  return beoordeelAlle(rijen)
    .filter(({ rij, oordeel }) => rij.status !== oordeel.status || rij.melding !== oordeel.melding)
    .map(({ rij, oordeel }) => ({
      itemId: rij.itemId,
      naam: rij.naam,
      status: oordeel.status,
      melding: oordeel.melding,
    }));
}

export interface TekstenWriter {
  mutate<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
}

const CHANGE_VALUES = `mutation ($board: ID!, $item: ID!, $values: JSON!) {
  change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values) { id }
}`;

/**
 * Schrijft de wijzigingen, één item per keer.
 *
 * Status op NAAM en niet op index: de namen staan in `STATUS_LABELS` en zijn wat een mens op
 * het bord ziet. Heeft iemand een label hernoemd, dan faalt dit hardop in plaats van stil de
 * verkeerde kleur te zetten.
 */
export async function schrijfStatussen(
  write: TekstenWriter,
  boardId: string,
  wijzigingen: readonly StatusWijziging[]
): Promise<void> {
  for (const w of wijzigingen) {
    await write.mutate(CHANGE_VALUES, {
      board: boardId,
      item: w.itemId,
      values: JSON.stringify({
        [TEKST_COLUMNS.status]: { label: w.status },
        [TEKST_COLUMNS.melding]: w.melding,
      }),
    });
  }
}

/** Het bord lezen, keuren, en bijwerken wat afwijkt. Geeft terug wat er veranderd is. */
export async function synchroniseerStatussen(
  read: TekstenReader,
  write: TekstenWriter,
  boardId: string
): Promise<readonly StatusWijziging[]> {
  const wijzigingen = statusWijzigingen(await readTekstRijen(read, boardId));
  await schrijfStatussen(write, boardId, wijzigingen);
  return wijzigingen;
}
