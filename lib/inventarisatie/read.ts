import { OPPORTUNITY_BOARD, OPPORTUNITY_COLUMNS } from '@lib/briefing/columns';
import { LABEL_COLUMNS, labelsBoardId } from '@lib/labels';
import { readLabelRows } from '@lib/labels/read';
import { assertColumns } from '@lib/monday/schema-check';

import type { LabelCode } from '@lib/labels';
import type { ExpectedColumn } from '@lib/monday/board-config';
import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { OpportunityStand } from './run';

const LABEL = OPPORTUNITY_COLUMNS.label;
const LINK = OPPORTUNITY_COLUMNS.inventarisatie;

const VELDEN = `id board { id } column_values(ids: ["${LABEL}", "${LINK}"]) {
  id ... on StatusValue { index } ... on LinkValue { url url_text }
}`;

/**
 * Eerst de kolomtypes, en weigeren als die niet kloppen. Een `Label` die geen statuskolom meer
 * is levert geen labelnummer, en een Website die geen link meer is geen adres: allebei zouden
 * lezen als "geen link hoort hier", en de nachtelijke ronde zou dan elke link wissen.
 */
const OPPORTUNITY_KOLOMMEN: readonly ExpectedColumn[] = [
  { id: LABEL, type: 'status' },
  { id: LINK, type: 'link' },
];
const LABELS_KOLOMMEN: readonly ExpectedColumn[] = [{ id: LABEL_COLUMNS.website, type: 'link' }];

async function keur(
  client: MondayGraphQLClient,
  boardId: string,
  verwacht: readonly ExpectedColumn[]
): Promise<void> {
  const [meta] = await client.getSchema([boardId]);
  if (meta === undefined) {
    throw new Error(`Bord ${boardId} niet gevonden of niet toegankelijk.`);
  }
  assertColumns(meta, verwacht);
}

interface Cel {
  readonly id: string;
  readonly index?: number | null;
  readonly url?: string | null;
  readonly url_text?: string | null;
}

interface Rij {
  readonly id: string | number;
  readonly board?: { readonly id: string | number } | null;
  readonly column_values?: readonly Cel[] | null;
}

interface Pagina {
  readonly cursor: string | null;
  readonly items: readonly Rij[];
}

const PAGE_SIZE = 200;
/** Ruim boven het bord (~1.000 rijen); de grens bestaat alleen om een cursor die niet afloopt te stoppen. */
const MAX_PAGES = 50;

/**
 * Ontbreekt een kolom in het antwoord, dan is hij hernoemd of weg: Monday laat een onbekend id
 * stil weg. Doorgaan zou elke Opportunity als "leeg" lezen en elke nacht opnieuw schrijven, of
 * elke link wissen.
 */
function stand(rij: Rij): OpportunityStand {
  const cel = (id: string): Cel => {
    const gevonden = (rij.column_values ?? []).find((c) => c.id === id);
    if (gevonden === undefined) {
      throw new Error(
        `Opportunity ${rij.id}: kolom "${id}" ontbreekt. Is hij hernoemd of verwijderd, of nog ` +
          'niet aangemaakt (pnpm opportunity:kolommen --apply)?'
      );
    }
    return gevonden;
  };
  const label = cel(LABEL);
  const link = cel(LINK);
  // Een lege statuscel heeft `index: null`; ontbreekt het veld, dan is het geen statuskolom meer.
  if (!('index' in label)) {
    throw new Error(`Opportunity ${rij.id}: "${LABEL}" levert geen labelnummer; is het type veranderd?`);
  }
  if (!('url' in link)) {
    throw new Error(`Opportunity ${rij.id}: "${LINK}" levert geen URL; is het type veranderd?`);
  }
  return {
    itemId: String(rij.id),
    labelIndex: typeof label.index === 'number' ? label.index : null,
    link: (link.url ?? '').trim(),
    tekst: (link.url_text ?? '').trim(),
  };
}

/** Eén Opportunity, of `null` als hij niet (meer) bestaat of niet op het Opportunitybord staat. */
export async function leesOpportunity(
  client: MondayGraphQLClient,
  itemId: string
): Promise<OpportunityStand | null> {
  await keur(client, OPPORTUNITY_BOARD, OPPORTUNITY_KOLOMMEN);
  const data = await client.query<{ items?: readonly Rij[] | null }>(
    `query ($ids: [ID!]) { items(ids: $ids) { ${VELDEN} } }`,
    { ids: [itemId] }
  );
  const rij = (data.items ?? [])[0];
  if (rij === undefined || String(rij.board?.id ?? '') !== OPPORTUNITY_BOARD) {
    return null;
  }
  return stand(rij);
}

/**
 * Het hele bord, pagina voor pagina en niet via `fetchBoardItems`: die weigert zodra iemand
 * tijdens het bladeren een rij bewerkt, en op dit bord werkt overdag altijd iemand (zie
 * `lib/overname/read.ts`). Een rij die de ronde mist komt de volgende nacht mee.
 */
export async function leesAlleOpportunities(
  client: MondayGraphQLClient
): Promise<readonly OpportunityStand[]> {
  await keur(client, OPPORTUNITY_BOARD, OPPORTUNITY_KOLOMMEN);
  const rijen = new Map<string, OpportunityStand>();
  let cursor: string | null = null;
  for (let pagina = 0; pagina < MAX_PAGES; pagina += 1) {
    let page: Pagina | undefined;
    if (cursor === null) {
      const data = await client.query<{ boards?: { items_page: Pagina }[] | null }>(
        `query ($board: [ID!], $limit: Int!) {
           boards(ids: $board) { items_page(limit: $limit) { cursor items { ${VELDEN} } } }
         }`,
        { board: [OPPORTUNITY_BOARD], limit: PAGE_SIZE }
      );
      page = data.boards?.[0]?.items_page;
    } else {
      const data = await client.query<{ next_items_page?: Pagina | null }>(
        `query ($cursor: String!, $limit: Int!) {
           next_items_page(cursor: $cursor, limit: $limit) { cursor items { ${VELDEN} } }
         }`,
        { cursor, limit: PAGE_SIZE }
      );
      page = data.next_items_page ?? undefined;
    }
    if (page === undefined) {
      throw new Error(`Opportunitybord ${OPPORTUNITY_BOARD}: Monday gaf geen pagina terug.`);
    }
    for (const rij of page.items) {
      rijen.set(String(rij.id), stand(rij));
    }
    if (page.cursor === null) {
      return [...rijen.values()];
    }
    cursor = page.cursor;
  }
  throw new Error(`Opportunitybord: meer dan ${MAX_PAGES} pagina's; de cursor loopt niet af.`);
}

/**
 * De website per label, live van het Labels-bord: past ITG een website aan, dan volgen de
 * links vanzelf. De soepele lezer, want een label zonder website (FT) is hier geen fout maar
 * "geen link".
 */
export async function leesWebsites(
  client: MondayGraphQLClient
): Promise<ReadonlyMap<LabelCode, string>> {
  const boardId = labelsBoardId();
  await keur(client, boardId, LABELS_KOLOMMEN);
  const { records } = await readLabelRows(client, boardId);
  /**
   * Eén label zonder website is gewoon (FT). Geen enkel label met een website is een kapot bord,
   * en zou elke link op het Opportunitybord laten wissen.
   */
  if (!records.some((r) => r.website.trim() !== '')) {
    throw new Error(
      `Labels-bord ${boardId}: geen enkel label heeft een website. Gestopt zonder links te wissen.`
    );
  }
  return new Map(records.map((r) => [r.code, r.website]));
}
