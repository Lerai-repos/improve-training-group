import { BRIEFING_AGENDA_COLUMNS, OPPORTUNITY_BOARD } from '@lib/briefing/columns';
import { assertColumns } from '@lib/monday/schema-check';

import { OPPORTUNITY_OVERNAME_COLUMNS } from './columns';

import type { AgendaBoard } from '@lib/evaluations';
import type { ExpectedColumn } from '@lib/monday/board-config';
import type { BoardMeta, MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { AgendaStand, OpportunityStand } from './regel';

const C = BRIEFING_AGENDA_COLUMNS;
const O = OPPORTUNITY_OVERNAME_COLUMNS;

/** `items(ids:)` levert er stilzwijgend hoogstens 25; zie [[itg-evaluation-join-viability]]. */
const ITEMS_BATCH = 25;

const PAGE_SIZE = 200;
/** 10.000 rijen tegen een bord van nog geen duizend: alleen een op hol geslagen cursor komt hier. */
const MAX_PAGES = 50;

export interface Kandidaat {
  readonly itemId: string;
  readonly boardId: string;
  readonly naam: string;
  /** `YYYY-MM-DD` */
  readonly datum: string;
  readonly opportunityItemId: string;
  readonly agenda: AgendaStand;
}

interface Cell {
  readonly id: string;
  readonly index?: number | null;
  readonly values?: ReadonlyArray<{ id: string | number }> | null;
  readonly linked_item_ids?: ReadonlyArray<string | number> | null;
  readonly date?: string | null;
}

interface Row {
  readonly id: string;
  readonly name?: string;
  readonly updated_at?: string | null;
  readonly column_values?: readonly Cell[] | null;
}

const byId = (row: Row): ReadonlyMap<string, Cell> =>
  new Map((row.column_values ?? []).map((c) => [c.id, c]));

const indexOf = (cell: Cell | undefined): number | null =>
  typeof cell?.index === 'number' ? cell.index : null;

/**
 * Wat een agendabord moet hebben vóór er iets van gelezen wordt.
 *
 * Monday laat een onbekend kolom-id stilzwijgend weg uit `column_values`. Zonder deze keuring
 * zou een verdwenen `Voorb. opdr.` lezen als "overal leeg", en zou deze job elke training
 * opnieuw willen vullen. De relatie moet ook nog naar het Opportunitybord wijzen: een
 * omgehangen relatie houdt id én type.
 *
 * `Huisw. opdr.` is de enige die mág ontbreken: Agenda 2025 heeft hem niet, en Tim besloot
 * dat 2025 niet meetelt. Ontbreekt hij, dan slaat de regel die kolom over.
 */
function verplichteKolommen(board: AgendaBoard): readonly ExpectedColumn[] {
  return [
    { id: board.datum, type: 'date' },
    {
      id: C.opportunity,
      type: 'board_relation',
      settingsIncludes: [`"boardIds":[${OPPORTUNITY_BOARD}]`],
    },
    { id: C.voorbereidend, type: 'status' },
    { id: C.duurcategorie, type: 'dropdown' },
  ];
}

const OPPORTUNITY_EXPECTED: readonly ExpectedColumn[] = [
  { id: O.voorbereidend, type: 'status' },
  { id: O.huiswerk, type: 'status' },
  { id: O.cyclus, type: 'status' },
];

async function gekeurdSchema(
  client: MondayGraphQLClient,
  boardId: string,
  expected: readonly ExpectedColumn[]
): Promise<BoardMeta> {
  const meta = await client.getSchema([boardId]);
  const board = meta[0];
  if (board === undefined) {
    throw new Error(`Bord ${boardId} niet gevonden of niet toegankelijk.`);
  }
  assertColumns(board, expected);
  return board;
}

interface Page {
  readonly cursor: string | null;
  readonly items: readonly Row[];
}

/**
 * Het hele bord, pagina voor pagina — met opzet NIET via `fetchBoardItems`.
 *
 * Die weigert de hele lezing zodra iemand tijdens het bladeren één rij bewerkt ("not a coherent
 * snapshot"). Voor een telling is dat terecht; hier legde het de job overdag plat op een bord
 * van bijna duizend rijen waar altijd wel iemand in werkt (gezien 21-Sep-2026). En hier is het
 * niet nodig: elke training wordt vlak voor het schrijven opnieuw gelezen (`herleesKandidaat`),
 * dus een rij die tijdens de scan veranderde wordt op haar actuele stand beoordeeld, en een rij
 * die de scan miste komt de volgende nacht gewoon mee.
 */
async function alleRijen(
  client: MondayGraphQLClient,
  boardId: string,
  fields: string
): Promise<readonly Row[]> {
  const rijen = new Map<string, Row>();
  let cursor: string | null = null;
  for (let pagina = 0; pagina < MAX_PAGES; pagina += 1) {
    let page: Page | undefined;
    if (cursor === null) {
      const data = await client.query<{ boards?: { items_page: Page }[] | null }>(
        `query ($board: [ID!], $limit: Int!) {
           boards(ids: $board) { items_page(limit: $limit) { cursor items { ${fields} } } }
         }`,
        { board: [boardId], limit: PAGE_SIZE }
      );
      page = data.boards?.[0]?.items_page;
    } else {
      const data = await client.query<{ next_items_page?: Page | null }>(
        `query ($cursor: String!, $limit: Int!) {
           next_items_page(cursor: $cursor, limit: $limit) { cursor items { ${fields} } }
         }`,
        { cursor, limit: PAGE_SIZE }
      );
      page = data.next_items_page ?? undefined;
    }
    if (page === undefined) {
      throw new Error(`Bord ${boardId}: Monday gaf geen pagina terug.`);
    }
    for (const row of page.items) {
      rijen.set(String(row.id), row);
    }
    if (page.cursor === null) {
      return [...rijen.values()];
    }
    cursor = page.cursor;
  }
  throw new Error(`Bord ${boardId}: meer dan ${MAX_PAGES} pagina's; de cursor loopt niet af.`);
}

/**
 * De komende trainingen op één agendabord die aan een Opportunity hangen, met wat er nu in de
 * drie doelcellen staat.
 *
 * Het hele bord en dan lokaal gefilterd op datum. Trainingen van gisteren en eerder doen niet
 * mee: daar verandert een voorgevulde cel niets meer aan. Zonder datum ook niet — dat is een
 * lege rij onder een Opportunity, geen training.
 */
export async function readKandidaten(
  client: MondayGraphQLClient,
  board: AgendaBoard,
  vandaag: string
): Promise<readonly Kandidaat[]> {
  const meta = await gekeurdSchema(client, board.boardId, verplichteKolommen(board));
  const huiswerk = meta.columns.find((c) => c.id === C.huiswerk);
  if (huiswerk !== undefined && huiswerk.type !== 'status') {
    throw new Error(`Kolom ${C.huiswerk} op bord ${board.boardId} is geen statuskolom meer.`);
  }
  const kolommen = new Set<string>([
    C.voorbereidend,
    C.duurcategorie,
    ...(huiswerk === undefined ? [] : [C.huiswerk]),
  ]);

  const ids = [board.datum, C.opportunity, C.voorbereidend, C.huiswerk, C.duurcategorie]
    .map((id) => `"${id}"`)
    .join(', ');
  const fields =
    `id name column_values(ids: [${ids}]) { id ` +
    '... on DateValue { date } ... on StatusValue { index } ' +
    '... on DropdownValue { values { id } } ... on BoardRelationValue { linked_item_ids } }';
  const rows = await alleRijen(client, board.boardId, fields);

  const uit: Kandidaat[] = [];
  for (const row of rows) {
    const cells = byId(row);
    const datum = cells.get(board.datum)?.date ?? null;
    const opportunity = (cells.get(C.opportunity)?.linked_item_ids ?? [])[0];
    if (datum === null || datum < vandaag || opportunity === undefined) {
      continue;
    }
    uit.push({
      itemId: String(row.id),
      boardId: board.boardId,
      naam: row.name ?? '',
      datum,
      opportunityItemId: String(opportunity),
      agenda: {
        voorbereidend: indexOf(cells.get(C.voorbereidend)),
        huiswerk: indexOf(cells.get(C.huiswerk)),
        duurcategorie: (cells.get(C.duurcategorie)?.values ?? []).map((v) => Number(v.id)),
        kolommen,
      },
    });
  }
  return uit;
}

/** De drie indexen van een reeks Opportunities, zonder schemakeuring. */
async function leesStanden(
  client: MondayGraphQLClient,
  ids: readonly string[]
): Promise<Map<string, OpportunityStand>> {
  const uit = new Map<string, OpportunityStand>();
  const kolommen = [O.voorbereidend, O.huiswerk, O.cyclus].map((id) => `"${id}"`).join(', ');
  for (let k = 0; k < ids.length; k += ITEMS_BATCH) {
    const data = await client.query<{ items?: Row[] | null }>(
      `query ($ids: [ID!]) {
         items(ids: $ids) {
           id
           column_values(ids: [${kolommen}]) { id ... on StatusValue { index } }
         }
       }`,
      { ids: ids.slice(k, k + ITEMS_BATCH) }
    );
    for (const row of data.items ?? []) {
      const cells = byId(row);
      uit.set(String(row.id), {
        voorbereidend: indexOf(cells.get(O.voorbereidend)),
        huiswerk: indexOf(cells.get(O.huiswerk)),
        cyclus: indexOf(cells.get(O.cyclus)),
      });
    }
  }
  return uit;
}

/** De drie antwoorden per Opportunity. Een item dat niet (meer) bestaat ontbreekt in de map. */
export async function readOpportunities(
  client: MondayGraphQLClient,
  ids: readonly string[]
): Promise<ReadonlyMap<string, OpportunityStand>> {
  await gekeurdSchema(client, OPPORTUNITY_BOARD, OPPORTUNITY_EXPECTED);
  return leesStanden(client, ids);
}

/**
 * Eén training en haar Opportunity opnieuw lezen, vlak voor het schrijven.
 *
 * De schema's zijn in dezelfde run al gekeurd, dus hier alleen de cellen. `null` als de
 * training weg is, intussen aan een andere Opportunity hangt, of die Opportunity niet meer
 * bestaat: dan klopt de vergelijking uit de scan niet meer en hoort er niets geschreven te
 * worden.
 *
 * Een doelkolom die in het antwoord ONTBREEKT werpt. Monday laat een onbekende kolom
 * stilzwijgend weg, en dat zou hier lezen als "nog steeds leeg" — precies de overschrijving
 * die deze herlezing moet voorkomen.
 */
export async function herleesKandidaat(
  client: MondayGraphQLClient,
  rij: Kandidaat
): Promise<{ readonly agenda: AgendaStand; readonly stand: OpportunityStand } | null> {
  const gevraagd = [C.opportunity, ...rij.agenda.kolommen];
  const ids = gevraagd.map((id) => `"${id}"`).join(', ');
  const data = await client.query<{ items?: Row[] | null }>(
    `query ($ids: [ID!]) {
       items(ids: $ids) {
         id
         column_values(ids: [${ids}]) { id ... on StatusValue { index }
           ... on DropdownValue { values { id } } ... on BoardRelationValue { linked_item_ids } }
       }
     }`,
    { ids: [rij.itemId] }
  );
  const row = (data.items ?? [])[0];
  if (row === undefined) {
    return null;
  }
  const cells = byId(row);
  const ontbreekt = gevraagd.filter((id) => !cells.has(id));
  if (ontbreekt.length > 0) {
    throw new Error(
      `Training ${rij.itemId}: kolom ${ontbreekt.join(', ')} ontbreekt in de herlezing; ` +
        'er wordt niet geschreven.'
    );
  }
  const opportunity = (cells.get(C.opportunity)?.linked_item_ids ?? [])[0];
  if (opportunity === undefined || String(opportunity) !== rij.opportunityItemId) {
    return null;
  }
  const stand = (await leesStanden(client, [rij.opportunityItemId])).get(rij.opportunityItemId);
  if (stand === undefined) {
    return null;
  }
  return {
    agenda: {
      voorbereidend: indexOf(cells.get(C.voorbereidend)),
      huiswerk: indexOf(cells.get(C.huiswerk)),
      duurcategorie: (cells.get(C.duurcategorie)?.values ?? []).map((v) => Number(v.id)),
      kolommen: rij.agenda.kolommen,
    },
    stand,
  };
}
