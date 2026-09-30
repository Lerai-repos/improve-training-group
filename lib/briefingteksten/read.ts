import { LABEL_COLUMNS } from '@lib/labels/columns';
import { assertColumns } from '@lib/monday/schema-check';

import { TEKST_COLUMNS, TEKST_EXPECTED_COLUMNS } from './columns';
import { tekstenUit } from './teksten';

import type { BoardMeta } from '@lib/monday/graphql-client';
import type { TekstRij } from './beoordeel';
import type { BriefingTeksten } from './types';

/**
 * Het bord lezen.
 *
 * Werpt bij alles wat op "een onvolledig beeld" lijkt: een ontbrekende kolom, een bord dat
 * niet terugkomt, of meer items dan één pagina. Dat is geen strengheid om de strengheid. Een
 * item dat niet gelezen wordt, telt als verwijderd, en dan verdwijnt die sectie stil uit elke
 * briefing. Dan liever geen briefing en een foutmelding in de tab.
 */

/** Ruim boven de 23 secties; een bord dat hier overheen gaat is niet meer wat we denken. */
const PAGINA = 200;

interface Cel {
  readonly id: string;
  readonly text?: string | null;
}

interface Item {
  readonly id: string;
  readonly name: string;
  readonly column_values?: readonly Cel[] | null;
}

/** Wat deze lezers van een Monday-client gebruiken; de echte client past er zonder cast in. */
export interface TekstenReader {
  getSchema(boardIds: string[]): Promise<BoardMeta[]>;
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
}

interface ItemsAntwoord {
  readonly boards?: ReadonlyArray<{
    readonly items_page?: {
      readonly cursor?: string | null;
      readonly items?: readonly Item[] | null;
    } | null;
  }> | null;
}

const tekstVan = (item: Item, kolom: string): string =>
  item.column_values?.find((c) => c.id === kolom)?.text ?? '';

/** Alle items van het bord, met hun kolommen. */
export async function readTekstRijen(
  client: TekstenReader,
  boardId: string
): Promise<readonly TekstRij[]> {
  const schema = (await client.getSchema([boardId]))[0];
  if (schema === undefined) {
    throw new Error(`Briefingteksten-bord ${boardId} niet gevonden of niet toegankelijk.`);
  }
  assertColumns(schema, TEKST_EXPECTED_COLUMNS);

  const kolommen = [
    TEKST_COLUMNS.kop,
    TEKST_COLUMNS.tekst,
    TEKST_COLUMNS.status,
    TEKST_COLUMNS.melding,
    TEKST_COLUMNS.sleutel,
  ];
  const data = await client.query<ItemsAntwoord>(
    `query ($b: [ID!], $c: [String!]) { boards(ids: $b) { items_page(limit: ${PAGINA}) {
       cursor items { id name column_values(ids: $c) { id text } } } } }`,
    { b: [boardId], c: kolommen }
  );
  const pagina = data.boards?.[0]?.items_page;
  if (pagina === undefined || pagina === null) {
    throw new Error(`Briefingteksten-bord ${boardId} gaf geen items terug.`);
  }
  if ((pagina.cursor ?? null) !== null) {
    throw new Error(
      `Briefingteksten-bord ${boardId} heeft meer dan ${PAGINA} items. Er horen er ongeveer 23 ` +
        'op te staan; ruim de extra items op.'
    );
  }
  return (pagina.items ?? []).map((item) => ({
    itemId: String(item.id),
    naam: item.name,
    sleutel: tekstVan(item, TEKST_COLUMNS.sleutel).trim(),
    kop: tekstVan(item, TEKST_COLUMNS.kop),
    tekst: tekstVan(item, TEKST_COLUMNS.tekst),
    status: tekstVan(item, TEKST_COLUMNS.status).trim(),
    melding: tekstVan(item, TEKST_COLUMNS.melding).trim(),
  }));
}

/**
 * `{merk}` en `{term}` van het Labels-bord.
 *
 * Niet via `readLabels`: die weigert het héle bord zodra bij één label een logo of website
 * ontbreekt, en dan kan geen enkel label nog een briefing maken om een veld dat de briefing
 * niet gebruikt. Hier telt alleen de rij van dít label, en alleen deze twee velden.
 */
export async function readMerk(
  client: TekstenReader,
  labelsBoardId: string,
  label: string
): Promise<{ readonly merk: string; readonly term: string }> {
  const data = await client.query<ItemsAntwoord>(
    `query ($b: [ID!], $c: [String!]) { boards(ids: $b) { items_page(limit: 100) {
       cursor items { id name column_values(ids: $c) { id text } } } } }`,
    { b: [labelsBoardId], c: [LABEL_COLUMNS.volledigeNaam, LABEL_COLUMNS.term] }
  );
  const code = label.trim().toUpperCase();
  const rijen = (data.boards?.[0]?.items_page?.items ?? []).filter(
    (item) => item.name.trim().toUpperCase() === code
  );
  if (rijen.length !== 1) {
    throw new Error(
      rijen.length === 0
        ? `Labels-bord: geen rij voor ${code}, dus {merk} en {term} zijn onbekend.`
        : `Labels-bord: ${rijen.length} rijen voor ${code}; niet te zeggen welke geldt.`
    );
  }
  const [rij] = rijen;
  const merk = tekstVan(rij, LABEL_COLUMNS.volledigeNaam).trim();
  const term = tekstVan(rij, LABEL_COLUMNS.term).trim();
  if (merk === '' || term === '') {
    throw new Error(
      `Labels-bord: bij ${code} is ${merk === '' ? 'Volledige naam' : 'Term'} leeg, en die ` +
        'staat in de briefing.'
    );
  }
  return { merk, term };
}

/** Alles wat één briefing aan teksten nodig heeft. */
export async function readBriefingTeksten(
  client: TekstenReader,
  input: { readonly boardId: string; readonly labelsBoardId: string; readonly label: string }
): Promise<BriefingTeksten> {
  const [rijen, merk] = await Promise.all([
    readTekstRijen(client, input.boardId),
    readMerk(client, input.labelsBoardId, input.label),
  ]);
  return tekstenUit(rijen, merk);
}
