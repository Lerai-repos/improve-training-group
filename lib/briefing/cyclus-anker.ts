/**
 * Onder welk item een schrijfactie op de checklist hoort te landen — bepaald op de server, op
 * het moment van schrijven.
 *
 * De tab weet bij het laden welk anker haar training heeft, maar dat kan daarna veranderen:
 * een collega bevestigt de cyclus anders, of een jaargang wordt gearchiveerd. Zou de tab dan
 * nog naar haar oude anker schrijven, dan landt de laatste wijziging onder een sleutel die
 * niemand meer leest.
 *
 * Twee kleine vragen, geen hele briefing: bij welke opdracht hoort dit item, en welk anker legt
 * het record voor zijn groep vast. Meer is er niet nodig, want het anker wordt niet afgeleid maar
 * staat in het record. Het hek dat meekomt is de versie van dat record: verandert het tussen nu
 * en het schrijven, dan gaat de schrijfactie niet door.
 */

import { BRIEFING_AGENDA_COLUMNS } from './columns';
import { groepVan, type CyclusStore } from './cyclus-bevestiging';

import type { Fence } from './checklist-store';

const C = BRIEFING_AGENDA_COLUMNS;

export interface AnkerReader {
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
}

interface RawCell {
  readonly id: string;
  readonly linked_item_ids?: ReadonlyArray<string | number> | null;
}

interface RawItem {
  readonly id: string | number;
  readonly column_values: readonly RawCell[];
}

/** De Opportunity van één agenda-item, of `null` als er geen gekoppeld is. */
async function readOpportunity(client: AnkerReader, itemId: string): Promise<string | null> {
  const data = await client.query<{ items?: RawItem[] }>(
    `query ($ids: [ID!]) {
       items(ids: $ids) {
         id
         column_values(ids: ["${C.opportunity}"]) { id ... on BoardRelationValue { linked_item_ids } }
       }
     }`,
    { ids: [itemId] }
  );
  const cel = data.items?.[0]?.column_values.find((c) => c.id === C.opportunity);
  if (cel === undefined) {
    throw new Error(
      `Briefing: kolom "${C.opportunity}" ontbreekt op training ${itemId}; een ontbrekende kolom ` +
        'is niet hetzelfde als een lege koppeling.'
    );
  }
  const eerste = (cel.linked_item_ids ?? [])[0];
  return eerste === undefined ? null : String(eerste);
}

/**
 * Het item waar de checklist van `itemId` onder staat: het vastgelegde anker van zijn bevestigde
 * cyclus, of hij zelf.
 */
export async function resolveChecklistAnker(
  client: AnkerReader,
  cycli: CyclusStore,
  itemId: string
): Promise<{ readonly anker: string; readonly fence: Fence | undefined }> {
  const opportunity = await readOpportunity(client, itemId);
  if (opportunity === null) {
    return { anker: itemId, fence: undefined };
  }
  const { stand, fence } = await cycli.readMetFence(opportunity);
  /**
   * Ook zonder groep gehekt: wordt dit item ná dit moment bij een cyclus gevinkt, dan hoort het
   * concept onder het anker van die cyclus en niet hier.
   */
  return { anker: groepVan(stand, itemId)?.anker ?? itemId, fence };
}
