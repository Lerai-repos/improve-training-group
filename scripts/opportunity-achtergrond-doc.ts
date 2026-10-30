/* eslint-disable no-console */
import { randomUUID } from 'node:crypto';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { OPPORTUNITY_BOARD, OPPORTUNITY_COLUMNS } from '@lib/briefing/columns';
import {
  alineasNaarBlokken,
  docObjectId,
  leesAchtergrondDoc,
  type DocAlinea,
} from '@lib/briefing/achtergrond-doc';

import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { MondayMutationClient } from '@lib/monday/mutate';

/**
 * Zet de tekst uit de lange-tekstkolom `itg_achtergrond` over naar het document in
 * `itg_achtergrond_doc`, op elke Opportunity waar die kolom gevuld is.
 *
 * Schrijft precies wat de briefing nu al uit de oude kolom haalt (`alineasNaarBlokken`): ITG's
 * vaste kopjes als titel, de rest als alinea. Na het schrijven wordt elk document teruggelezen
 * via de lezer van de briefing zelf en alinea voor alinea vergeleken.
 *
 * Een document dat al bestaat wordt **nooit overschreven**: is het gelijk, dan is het al klaar;
 * is het leeg, dan wordt het gevuld; wijkt het af, dan staat het in het verslag en blijft het
 * staan. Daardoor is opnieuw draaien veilig, ook nadat accountmanagers in het document werken.
 *
 *   pnpm opportunity:achtergrond-doc                 # droogloop: laat zien wat het zou doen
 *   pnpm opportunity:achtergrond-doc --apply
 *   pnpm opportunity:achtergrond-doc --board <id>    # een ander bord met dezelfde kolom-ids
 */

const EXIT_FAILURE = 1;
const ITEMS_PAGE = 500;
/**
 * Twee Opportunities tegelijk. Elk kost drie aanroepen (document, blokken, teruglezen); met vier
 * tegelijk en één aanroep per blok gaf Monday 429 (29-Oct-2026).
 */
const GELIJKTIJDIG = 2;
/** Zoveel keer leegmaken; een document van meer dan 5.000 blokken is geen achtergrondtekst. */
const MAX_LEEGRONDES = 50;

/**
 * In elke idempotentiesleutel van een blokschrijfactie.
 *
 * Monday houdt een sleutel 30 minuten vast. Binnen één aanroep moet hij gelijk blijven, zodat
 * een herhaling na een time-out geen tweede blok maakt. Maar een volgende run, of een tweede
 * poging na leegmaken, is een echte nieuwe schrijfactie en mag niet worden tegengehouden.
 */
const RUN = randomUUID();

interface Cel {
  id: string;
  text: string | null;
  value: string | null;
}

interface Item {
  id: string;
  name: string;
  column_values: Cel[];
}

interface Page {
  cursor: string | null;
  items: Item[];
}

type Uitkomst =
  | { kind: 'klaar' }
  | { kind: 'gevuld'; alineas: number }
  | { kind: 'zou-vullen'; alineas: number }
  | { kind: 'afwijkend'; detail: string }
  | { kind: 'mislukt'; detail: string };

function arg(naam: string): string | null {
  const at = process.argv.indexOf(naam);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
}

function verwacht(tekst: string): DocAlinea[] {
  return alineasNaarBlokken(tekst).map((b) =>
    b.type === 'medium_title'
      ? { tekst: b.tekst, kop: true, niveau: 2 }
      : { tekst: b.tekst, kop: false, niveau: 0 }
  );
}

/** De eerste alinea die verschilt, leesbaar voor het verslag; `null` als ze gelijk zijn. */
function verschil(gelezen: readonly DocAlinea[], bedoeld: readonly DocAlinea[]): string | null {
  const lengte = Math.max(gelezen.length, bedoeld.length);
  for (let i = 0; i < lengte; i += 1) {
    const a = gelezen[i];
    const b = bedoeld[i];
    if (a?.tekst !== b?.tekst || a?.kop !== b?.kop || a?.niveau !== b?.niveau) {
      return (
        `alinea ${i + 1} van ${bedoeld.length}: ` +
        `staat ${JSON.stringify(a?.tekst ?? null)}${a?.kop ? ' (kop)' : ''}, ` +
        `verwacht ${JSON.stringify(b?.tekst ?? null)}${b?.kop ? ' (kop)' : ''}`
      );
    }
  }
  return null;
}

async function leesBord(read: MondayGraphQLClient, board: string): Promise<Item[]> {
  const kolommen = JSON.stringify([
    OPPORTUNITY_COLUMNS.achtergrond,
    OPPORTUNITY_COLUMNS.achtergrondDoc,
  ]);
  const velden = `cursor items { id name column_values(ids: ${kolommen}) { id text value } }`;
  const eerste = await read.query<{ boards: Array<{ items_page: Page }> }>(
    `query ($b: [ID!], $limit: Int) { boards(ids: $b) { items_page(limit: $limit) { ${velden} } } }`,
    { b: [board], limit: ITEMS_PAGE }
  );
  let pagina = eerste.boards?.[0]?.items_page;
  if (pagina === undefined) {
    throw new Error(`Bord ${board} gaf geen items terug`);
  }
  const items = [...pagina.items];
  while (pagina.cursor !== null) {
    const volgende: { next_items_page: Page } = await read.query(
      `query ($c: String!, $limit: Int) { next_items_page(cursor: $c, limit: $limit) { ${velden} } }`,
      { c: pagina.cursor, limit: ITEMS_PAGE }
    );
    pagina = volgende.next_items_page;
    items.push(...pagina.items);
  }
  return items;
}

/** Monday laat een onbekend kolom-id stilzwijgend weg; dan zou alles "leeg" lijken. */
function cel(item: Item, id: string): Cel {
  const gevonden = item.column_values.find((c) => c.id === id);
  if (gevonden === undefined) {
    throw new Error(`Kolom ${id} ontbreekt op item ${item.id}; gestopt zonder iets te wijzigen.`);
  }
  return gevonden;
}

/**
 * Alle blokken van één document in één verzoek.
 *
 * Eén verzoek per blok liep op 29-Oct-2026 vast op Monday's 429 (ruim 1.700 aanroepen in een paar
 * minuten). Daarom alle `create_doc_block`s als aliassen in één mutatie. GraphQL voert die op
 * volgorde uit, maar **zonder `after_block_id` zet Monday elk blok bovenaan** (gemeten: 30 blokken
 * kwamen omgekeerd terug). Dus in omgekeerde volgorde sturen; het teruglezen daarna bewijst het.
 */
async function schrijfBlokken(
  write: MondayMutationClient,
  board: string,
  itemId: string,
  docId: string,
  tekst: string
): Promise<void> {
  const blokken = alineasNaarBlokken(tekst).reverse();
  const definities = ['$doc: ID!'];
  const velden: string[] = [];
  const variabelen: Record<string, unknown> = { doc: docId };
  for (const [index, blok] of blokken.entries()) {
    definities.push(`$t${index}: DocBlockContentType!`, `$c${index}: JSON!`);
    velden.push(
      `b${index}: create_doc_block(doc_id: $doc, type: $t${index}, content: $c${index}) { id }`
    );
    variabelen[`t${index}`] = blok.type;
    variabelen[`c${index}`] = JSON.stringify({
      alignment: 'left',
      direction: 'ltr',
      deltaFormat: [{ insert: blok.tekst }],
    });
  }
  await write.mutate(`mutation (${definities.join(', ')}) { ${velden.join('\n')} }`, variabelen, {
    idempotencyKey: `achtergrond-doc:${board}:${itemId}:${docId}:${RUN}:blokken`,
  });
}

/**
 * Het trage, zekere pad: blok voor blok, elk ná het vorige (`after_block_id`).
 *
 * Alleen voor een document waar de snelle weg (`schrijfBlokken`) een blok op de verkeerde plek
 * zette: gemeten 29-Oct-2026 bij 4 van 169. Eén aanroep per blok, dus niet voor allemaal.
 */
async function schrijfBlokkenGeketend(
  write: MondayMutationClient,
  docId: string,
  tekst: string
): Promise<void> {
  const poging = randomUUID();
  let na: string | null = null;
  for (const [index, blok] of alineasNaarBlokken(tekst).entries()) {
    const content = JSON.stringify({
      alignment: 'left',
      direction: 'ltr',
      deltaFormat: [{ insert: blok.tekst }],
    });
    const gemaakt: { create_doc_block: { id: string } } = await write.mutate(
      `mutation ($doc: ID!, $type: DocBlockContentType!, $content: JSON!, $na: String) {
         create_doc_block(doc_id: $doc, type: $type, content: $content, after_block_id: $na) { id }
       }`,
      { doc: docId, type: blok.type, content, na },
      { idempotencyKey: `achtergrond-doc:${docId}:${poging}:${index}` }
    );
    na = gemaakt.create_doc_block.id;
  }
}

/**
 * Alle blokken uit een document halen, zodat het opnieuw geschreven kan worden.
 *
 * Herhalen tot er niets meer staat: één ronde ziet hoogstens een pagina van 100 blokken, en wat
 * daarna bleef staan kwam anders vóór de herschreven tekst terecht.
 */
async function leegDocument(
  read: MondayGraphQLClient,
  write: MondayMutationClient,
  objectId: string
): Promise<void> {
  for (let ronde = 0; ronde < MAX_LEEGRONDES; ronde += 1) {
    const data = await read.query<{ docs: Array<{ blocks: Array<{ id: string }> | null }> }>(
      'query ($o: [ID!]) { docs(object_ids: $o) { blocks(limit: 100) { id } } }',
      { o: [objectId] }
    );
    const ids = (data.docs?.[0]?.blocks ?? []).map((b) => b.id);
    if (ids.length === 0) {
      return;
    }
    const velden = ids.map((_, i) => `d${i}: delete_doc_block(block_id: $b${i}) { id }`);
    const definities = ids.map((_, i) => `$b${i}: String!`);
    const variabelen = Object.fromEntries(ids.map((id, i) => [`b${i}`, id]));
    await write.mutate(`mutation (${definities.join(', ')}) { ${velden.join('\n')} }`, variabelen);
  }
  throw new Error(`document ${objectId} raakte na ${MAX_LEEGRONDES} rondes niet leeg`);
}

async function docId(read: MondayGraphQLClient, objectId: string): Promise<string> {
  const data = await read.query<{ docs: Array<{ id: string }> }>(
    'query ($o: [ID!]) { docs(object_ids: $o) { id } }',
    { o: [objectId] }
  );
  const id = data.docs?.[0]?.id;
  if (id === undefined) {
    throw new Error(`document ${objectId} niet gevonden`);
  }
  return id;
}

async function leesItem(read: MondayGraphQLClient, id: string): Promise<Item> {
  const kolommen = JSON.stringify([
    OPPORTUNITY_COLUMNS.achtergrond,
    OPPORTUNITY_COLUMNS.achtergrondDoc,
  ]);
  const data = await read.query<{ items: Item[] }>(
    `query ($i: [ID!]) { items(ids: $i) { id name column_values(ids: ${kolommen}) { id text value } } }`,
    { i: [id] }
  );
  const item = data.items?.[0];
  if (item === undefined) {
    throw new Error(`item ${id} niet meer gevonden`);
  }
  return item;
}

async function verwerk(
  read: MondayGraphQLClient,
  write: MondayMutationClient,
  board: string,
  uitLijst: Item,
  apply: boolean
): Promise<Uitkomst> {
  /**
   * Bij schrijven het item opnieuw lezen: de lijst is aan het begin van de run opgehaald, en een
   * accountmanager die intussen de oude kolom aanpaste zou anders een verouderde tekst in het
   * document krijgen — die de briefing dan vóór zijn nieuwe tekst zet.
   */
  const item = apply ? await leesItem(read, uitLijst.id) : uitLijst;
  const tekst = cel(item, OPPORTUNITY_COLUMNS.achtergrond).text ?? '';
  const bedoeld = verwacht(tekst);
  const objectId = docObjectId(cel(item, OPPORTUNITY_COLUMNS.achtergrondDoc).value);

  if (objectId !== null) {
    const gelezen = await leesAchtergrondDoc(read, objectId);
    if (gelezen.length > 0) {
      const anders = verschil(gelezen, bedoeld);
      return anders === null ? { kind: 'klaar' } : { kind: 'afwijkend', detail: anders };
    }
  }
  if (!apply) {
    return { kind: 'zou-vullen', alineas: bedoeld.length };
  }

  let doelObject = objectId;
  let doel: string;
  if (doelObject === null) {
    const gemaakt = await write.mutate<{ create_doc: { id: string; object_id: string } }>(
      `mutation ($item: ID!, $col: String!) {
         create_doc(location: { board: { item_id: $item, column_id: $col } }) { id object_id }
       }`,
      { item: item.id, col: OPPORTUNITY_COLUMNS.achtergrondDoc },
      { idempotencyKey: `achtergrond-doc:${board}:${item.id}` }
    );
    doel = String(gemaakt.create_doc.id);
    doelObject = String(gemaakt.create_doc.object_id);
  } else {
    doel = await docId(read, doelObject);
  }

  /**
   * Vanaf hier is het document van ons: het was leeg of is net gemaakt. Een half gevuld document
   * mag nooit blijven staan. De briefing zet het vóór de volledige tekst in de oude kolom, en een
   * volgende run noemt het `afwijkend` en blijft er dus af. Mislukt of wijkt iets af, dan gaat het
   * document weer leeg: dan geldt de oude kolom weer en vult een volgende run het opnieuw.
   */
  let snel = 'teruggelezen wijkt af';
  try {
    await schrijfBlokken(write, board, item.id, doel, tekst);
    if (verschil(await leesAchtergrondDoc(read, doelObject), bedoeld) === null) {
      return { kind: 'gevuld', alineas: bedoeld.length };
    }
  } catch (error) {
    // Eén alias kan mislukken nadat de eerdere al zijn opgeslagen; het trage pad ruimt dat op.
    snel = error instanceof Error ? error.message : String(error);
  }

  let detail: string;
  try {
    await leegDocument(read, write, doelObject);
    await schrijfBlokkenGeketend(write, doel, tekst);
    const anders = verschil(await leesAchtergrondDoc(read, doelObject), bedoeld);
    if (anders === null) {
      return { kind: 'gevuld', alineas: bedoeld.length };
    }
    detail = `teruggelezen wijkt af: ${anders}`;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }

  try {
    await leegDocument(read, write, doelObject);
    return {
      kind: 'mislukt',
      detail: `${detail} (snelle weg: ${snel}); document weer leeggemaakt, opnieuw draaien vult het`,
    };
  } catch (error) {
    const opruimen = error instanceof Error ? error.message : String(error);
    return {
      kind: 'mislukt',
      detail:
        `${detail}; LEEGMAKEN MISLUKT (${opruimen}): document ${doelObject} kan half gevuld ` +
        'zijn en gaat in de briefing vóór de oude kolom. Met de hand leegmaken.',
    };
  }
}

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const apply = process.argv.includes('--apply');
  const board = arg('--board') ?? OPPORTUNITY_BOARD;
  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });

  const [meta] = await read.getSchema([board]);
  if (meta === undefined) {
    throw new Error(`Bord ${board} niet gevonden of niet toegankelijk`);
  }
  const type = (id: string) => meta.columns.find((c) => c.id === id)?.type;
  if (type(OPPORTUNITY_COLUMNS.achtergrond) !== 'long_text') {
    throw new Error(
      `Bord ${board} ("${meta.name}") mist de lange-tekstkolom ${OPPORTUNITY_COLUMNS.achtergrond}`
    );
  }
  if (type(OPPORTUNITY_COLUMNS.achtergrondDoc) !== 'doc') {
    throw new Error(
      `Bord ${board} ("${meta.name}") mist de Doc-kolom ${OPPORTUNITY_COLUMNS.achtergrondDoc}. ` +
        'Maak hem eerst aan met `pnpm opportunity:kolommen --apply`.'
    );
  }
  console.log(`\nBord ${board} — ${meta.name}${apply ? '' : '  (droogloop)'}\n`);

  const items = (await leesBord(read, board)).filter(
    (item) => (cel(item, OPPORTUNITY_COLUMNS.achtergrond).text ?? '').trim() !== ''
  );
  console.log(`  ${items.length} Opportunities met tekst in ${OPPORTUNITY_COLUMNS.achtergrond}\n`);

  const uitkomsten = new Map<string, Uitkomst>();
  let volgende = 0;
  const werker = async (): Promise<void> => {
    while (volgende < items.length) {
      const item = items[volgende];
      volgende += 1;
      if (item === undefined) {
        return;
      }
      let uitkomst: Uitkomst;
      try {
        uitkomst = await verwerk(read, write, board, item, apply);
      } catch (error) {
        uitkomst = {
          kind: 'mislukt',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      uitkomsten.set(item.id, uitkomst);
      if (
        uitkomst.kind === 'gevuld' ||
        uitkomst.kind === 'afwijkend' ||
        uitkomst.kind === 'mislukt'
      ) {
        const detail = 'detail' in uitkomst ? ` — ${uitkomst.detail}` : '';
        console.log(`  ${uitkomst.kind.padEnd(9)} ${item.id}  ${item.name}${detail}`);
      }
    }
  };
  await Promise.all(Array.from({ length: GELIJKTIJDIG }, werker));

  const tel = (kind: Uitkomst['kind']) =>
    [...uitkomsten.values()].filter((u) => u.kind === kind).length;
  console.log(
    `\n  klaar ${tel('klaar')}, gevuld ${tel('gevuld')}, zou vullen ${tel('zou-vullen')}, ` +
      `afwijkend ${tel('afwijkend')}, mislukt ${tel('mislukt')}`
  );
  if (!apply) {
    console.log('\n  Droogloop. Voer uit met --apply om de documenten echt te vullen.');
  }
  console.log('');
  if (tel('mislukt') > 0) {
    process.exit(EXIT_FAILURE);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
