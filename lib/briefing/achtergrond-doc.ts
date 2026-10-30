import { z } from 'zod';

import type { MondayGraphQLClient } from '@lib/monday/graphql-client';

/**
 * De achtergrondinformatie als Monday-document (Doc-kolom `itg_achtergrond_doc`).
 *
 * Waarom een document en niet de lange-tekstkolom: die houdt hoogstens 2.000 tekens vast. Gemeten
 * 29-Oct-2026: van de 169 Opportunities met een achtergrondtekst stonden er ruim 125 op precies
 * 2.000 tekens, afgekapt met `...`. Een document heeft geen grens, en kent echte kopjes en
 * alinea's, zodat we ze niet meer uit dubbele spaties hoeven te raden (`herstelAlineas`).
 */

/**
 * Zoveel blokken per pagina.
 *
 * **Zonder `limit` geeft Monday er stilzwijgend 25**, ook als het document er meer heeft.
 * Gemeten 29-Oct-2026 op een document van 40 blokken: 25 terug, geen foutmelding. Vandaar
 * pagineren tot een pagina niet vol is.
 */
export const DOC_BLOCK_PAGE = 100;

/** Een document van meer dan 5.000 blokken is geen achtergrondtekst maar een lus. */
const MAX_PAGES = 50;

/**
 * Een losse serverfout van de docs-API nog twee keer proberen.
 *
 * Gemeten 29-Oct-2026: 4 van 169 leesacties gaven `Internal server error` (HTTP 200, dus de
 * client probeert het zelf niet opnieuw), en een tweede poging slaagde. Zonder dit zou ongeveer
 * één op de vijftig keer de briefing-tab niet laden. Lezen is veilig om te herhalen.
 */
const POGINGEN = 3;
const WACHT_MS = 500;
const SERVERFOUT = /internal server error/i;

const wacht = (ms: number): Promise<void> => new Promise((klaar) => setTimeout(klaar, ms));

/**
 * Hoe groot een kopje in de briefing komt: 1 groot, 2 middel, 3 klein, 0 geen kopje. Volgt de
 * drie titelsoorten van een Monday-document; de sjablonen hebben voor elk een eigen alinea.
 */
export type KopNiveau = 0 | 1 | 2 | 3;

/** Eén alinea van de achtergrond; `kop` als het in het document een titel is. */
export interface DocAlinea {
  readonly tekst: string;
  readonly kop: boolean;
  readonly niveau: KopNiveau;
}

/** Een blok zoals `docs { blocks { type content } }` het teruggeeft. */
export interface RawDocBlock {
  readonly type: string;
  readonly content: string | null;
}

const docCelSchema = z.object({
  files: z.array(
    z.object({
      objectId: z.union([z.number(), z.string()]),
      fileType: z.string().optional(),
    })
  ),
});

/**
 * Het object-id van het document in een Doc-cel, of `null` als er geen document in zit.
 *
 * Gemeten 29-Oct-2026: een lege cel geeft `value: null`, een gevulde
 * `{"files":[{"objectId":…,"fileType":"MONDAY_DOC",…}]}`. `text` is in beide gevallen leeg,
 * dus daar valt niets uit af te leiden. Een andere vorm is drift en geen leeg document.
 */
export function docObjectId(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Briefing: de Doc-kolom gaf geen leesbare waarde terug: ${value.slice(0, 80)}`);
  }
  const cel = docCelSchema.safeParse(parsed);
  if (!cel.success) {
    throw new Error(`Briefing: de Doc-kolom gaf een onbekende vorm terug: ${value.slice(0, 80)}`);
  }
  const doc = cel.data.files.find((f) => f.fileType === undefined || f.fileType === 'MONDAY_DOC');
  return doc === undefined ? null : String(doc.objectId);
}

const inhoudSchema = z.object({
  deltaFormat: z.array(z.object({ insert: z.unknown() })).optional(),
});

/** De platte tekst van één blok; leeg voor blokken zonder tekst (scheidingslijn, plaatje). */
function blokTekst(blok: RawDocBlock): string {
  if (blok.content === null || blok.content === '') {
    return '';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blok.content);
  } catch {
    return '';
  }
  const inhoud = inhoudSchema.safeParse(parsed);
  if (!inhoud.success) {
    return '';
  }
  // Alleen tekst; een vermelding of plaatje komt als object en hoort niet in de briefing.
  return (inhoud.data.deltaFormat ?? [])
    .map((stuk) => (typeof stuk.insert === 'string' ? stuk.insert : ''))
    .join('');
}

const TITELS = new Map<string, KopNiveau>([
  ['large title', 1],
  ['medium title', 2],
  ['small title', 3],
]);
const OPSOMMINGEN = new Set(['bulleted list', 'check list']);
const GENUMMERD = 'numbered list';

/**
 * De blokken van een document als alinea's, in documentvolgorde.
 *
 * Titels worden een kop (vet in de briefing, op de grootte van hun titelsoort). Een opsomming krijgt een `•`, een genummerde
 * lijst zijn nummer: de briefing kent alleen alinea's, en zonder dat teken leest een lijst als
 * losse zinnen. Een zachte regelafbreking binnen een blok wordt een eigen alinea, zoals in de
 * tab ook elke regel een alinea is.
 */
export function blokkenNaarAlineas(blokken: readonly RawDocBlock[]): DocAlinea[] {
  const alineas: DocAlinea[] = [];
  let nummer = 0;
  for (const blok of blokken) {
    nummer = blok.type === GENUMMERD ? nummer + 1 : 0;
    const regels = blokTekst(blok)
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r !== '');
    for (const regel of regels) {
      const titel = TITELS.get(blok.type);
      if (titel !== undefined) {
        alineas.push({ tekst: regel, kop: true, niveau: titel });
      } else if (OPSOMMINGEN.has(blok.type)) {
        alineas.push({ tekst: `• ${regel}`, kop: false, niveau: 0 });
      } else if (blok.type === GENUMMERD) {
        alineas.push({ tekst: `${nummer}. ${regel}`, kop: false, niveau: 0 });
      } else {
        alineas.push({ tekst: regel, kop: false, niveau: 0 });
      }
    }
  }
  return alineas;
}

const docsSchema = z.object({
  docs: z.array(
    z.object({
      blocks: z.array(z.object({ type: z.string(), content: z.string().nullable() })).nullable(),
    })
  ),
});

/**
 * Alle alinea's van één document.
 *
 * Een cel die naar een document wijst dat niet terugkomt is drift (verwijderd, geen toegang),
 * geen lege tekst: anders verdwijnt de achtergrond zonder dat iemand weet waarom.
 */
export async function leesAchtergrondDoc(
  client: Pick<MondayGraphQLClient, 'query'>,
  objectId: string,
  opties: { readonly wachtMs?: number } = {}
): Promise<DocAlinea[]> {
  const wachtMs = opties.wachtMs ?? WACHT_MS;
  const vraag = async (variabelen: Record<string, unknown>): Promise<unknown> => {
    for (let poging = 1; ; poging += 1) {
      try {
        return await client.query<unknown>(
          `query ($ids: [ID!], $limit: Int, $page: Int) {
             docs(object_ids: $ids) { id blocks(limit: $limit, page: $page) { type content } }
           }`,
          variabelen
        );
      } catch (error) {
        const melding = error instanceof Error ? error.message : String(error);
        if (poging >= POGINGEN || !SERVERFOUT.test(melding)) {
          throw error;
        }
        await wacht(wachtMs * poging);
      }
    }
  };

  const blokken: RawDocBlock[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const raw = await vraag({ ids: [objectId], limit: DOC_BLOCK_PAGE, page });
    const parsed = docsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Briefing: document ${objectId} gaf een onbekende vorm terug`);
    }
    const doc = parsed.data.docs[0];
    if (doc === undefined) {
      throw new Error(
        `Briefing: het achtergronddocument ${objectId} is niet gevonden. Verwijderd, of geen ` +
          'toegang; controleer de Doc-kolom op de Opportunity.'
      );
    }
    const pagina = doc.blocks ?? [];
    blokken.push(...pagina);
    if (pagina.length < DOC_BLOCK_PAGE) {
      return blokkenNaarAlineas(blokken);
    }
  }
  throw new Error(`Briefing: document ${objectId} heeft meer dan ${MAX_PAGES} pagina's blokken`);
}
