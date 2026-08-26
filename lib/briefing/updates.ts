/**
 * De gemarkeerde Monday-updates: het blok "Extra informatie trainer".
 *
 * Afspraak van 29 mei, letterlijk in `06-briefing.md`:
 *
 * > *We raden niet, we lezen alleen wat gemarkeerd is. Dit is bewust zo afgesproken: het is
 * > voorspelbaar en ITG houdt de regie.*
 *
 * Die line is geen preutsheid. Gemeten over het agendabord: 1686 updates op 823 items,
 * waarvan er **21** de markering dragen. Alles meenemen zou de halve mailbox in de briefing
 * zetten — een flink deel van die updates is automatisch gelogde e-mail.
 *
 * ## Waarom de markering aan het begin moet staan
 *
 * Eén update op het agendabord luidt `zie planning voor in briefing en voor trainers`. Dat
 * is een notitie aan zichzelf, geen briefingtekst, en op "bevat de zin" zou hij meekomen.
 * Op het Opportunitybord staan er 32 die de zin bevatten en 29 die ermee beginnen. De
 * markering is dus alleen een markering als de update ermee **opent**.
 */

import type { MondayGraphQLClient } from '@lib/monday/graphql-client';

/**
 * `Voor in briefing:`, en alles wat ITG er in de praktijk van maakt.
 *
 * Aangetroffen varianten: `Voor in briefing:`, `Voor in de briefing:`, `voor in briefing:`
 * met kleine letter, met en zonder dubbele punt, met een spatie erachter.
 */
const MARKER = /^\s*voor\s+in\s+(?:de\s+)?briefing\s*:?[ \t]*/i;

/**
 * De line die Monday zelf onderaan een update plakt als hij bij een statuswijziging hoort,
 * bijvoorbeeld `Note on Brie - Aanmaken`. Staat altijd als last en is geen tekst van de
 * adviseur, dus die hoort niet in de briefing.
 */
const MONDAY_NOTE_LINE = /^Note on .+ - .+$/;

/**
 * Onzichtbare tekens die Monday’s editor in `text_body` achterlaat: de zero-width space
 * en de byte-order mark. Ze staan midden in echte zinnen en breken elke vergelijking.
 */
const INVISIBLE = /[\u200b\ufeff]/g;

/** Regelafbrekingen gelijktrekken en de onzichtbare tekens eruit. */
function normalise(textBody: string | null | undefined): string {
  return (textBody ?? '').replace(/\r\n/g, '\n').replace(INVISIBLE, '');
}

/** Regels die een opsomming beginnen; de rest van een paragraph is doorlopende tekst. */
const BULLET_MARK = /^\s*(?:[*•–-]\s+|\d+[.)]\s+)/;

/** Eén update zoals Monday hem teruggeeft. */
export interface RawUpdate {
  readonly textBody: string | null;
  readonly createdAt: string;
}

/** Draagt deze update de markering? */
export function isMarked(textBody: string | null | undefined): boolean {
  return MARKER.test(normalise(textBody));
}

/**
 * De paragraph's van één gemarkeerde update, zonder de markering en zonder Monday's eigen
 * notitieregel. Een lege list betekent: de update droeg de markering maar er stond verder
 * niets in.
 *
 * ## Waarom losse lines aan elkaar worden geplakt
 *
 * Twee vormen komen allebei echt voor, en ze zien er in `text_body` hetzelfde uit:
 *
 * ```
 * Extra                                   * Ze hebben geen scherm
 * aandacht van trainer om het te          * Is een training die eerst
 * laten beklijven.                        * Irene heeft het contact gehad
 * ```
 *
 * Links een harde regelafbreking midden in een zin (Monday's editor doet dit bij geplakte
 * tekst), rechts een opsomming. Splitsen op elke line maakt van de linker `Extra` een
 * losse paragraph; alles aan elkaar plakken maakt van de rechter één onleesbare line.
 *
 * Daarom: binnen een paragraph worden lines aan elkaar geplakt met een spatie, **behalve** als
 * de volgende line met een opsommingsteken begint. Dan is het een nieuw punt.
 */
export function parseMarkedUpdate(textBody: string | null | undefined): string[] {
  const raw = normalise(textBody);
  if (!MARKER.test(raw)) {
    return [];
  }
  const withoutMarker = raw.replace(MARKER, '');
  const lines = withoutMarker.split('\n').map((r) => r.trimEnd());

  /** Monday's eigen notitieregel staat achteraan; alles ervoor is van de adviseur. */
  while (lines.length > 0) {
    const last = lines[lines.length - 1]!.trim();
    if (last === '' || MONDAY_NOTE_LINE.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }

  const paragraphs: string[] = [];
  let current = '';
  const flush = (): void => {
    const tekst = current.trim();
    if (tekst !== '') {
      paragraphs.push(tekst);
    }
    current = '';
  };
  for (const line of lines) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (current !== '' && BULLET_MARK.test(line)) {
      flush();
    }
    const clean = line.replace(BULLET_MARK, '').trim();
    current = current === '' ? clean : `${current} ${clean}`;
  }
  flush();
  return paragraphs;
}

/** Wat er uit de updates van één training komt. */
export interface ExtraInfoResult {
  readonly lines: readonly string[];
  /**
   * `true` als Monday de updateslijst heeft truncated en er dus tekst kán missen. Dat is een
   * gegevensconditie en geen schemafout, dus het levert geen `throw` op — maar het mag ook
   * niet stil blijven, want een briefing die tekst mist ziet er compleet uit.
   */
  readonly truncated: boolean;
}

/**
 * Alle gemarkeerde updates van een training, chronologisch en zonder dubbelen.
 *
 * De agenda-updates en de Opportunity-updates gaan hier samen door één zeef. Dat is nodig
 * omdat dezelfde opmerking op beide plekken kan staan: het Opportunitybord is waar ITG ze
 * volgens hun eigen deck het liefst zet (*"kunnen we vanaf Opportunitybord erin zetten"*),
 * en gemeten dragen daar 29 updates de markering tegen 21 op het agendabord.
 *
 * Chronologisch en niet nieuwste-eerst, omdat de adviseur ze in die volgorde heeft
 * geschreven en een latere opmerking meestal op een eerdere voortbouwt.
 */
export function collectExtraInfo(
  updates: readonly RawUpdate[],
  options: { truncated?: boolean } = {}
): ExtraInfoResult {
  const sorted = [...updates].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const update of sorted) {
    for (const paragraph of parseMarkedUpdate(update.textBody)) {
      const key = paragraph.replace(/\s+/g, ' ').toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      lines.push(paragraph);
    }
  }
  return { lines, truncated: options.truncated ?? false };
}

/**
 * Hoeveel updates we per item ophalen.
 *
 * Ruim boven wat er in de praktijk staat: het drukste item op het agendabord heeft er een
 * handvol. De grens bestaat alleen om te merken dát hij geraakt wordt.
 */
const UPDATE_LIMIT = 100;

/**
 * De gemarkeerde updates van een training, van het agenda-item én van de gekoppelde
 * Opportunity.
 *
 * De Opportunity is een **apart item op een ander bord**, dus dat is een tweede sprong.
 * `items(ids:)` zoekt accountbreed, dus beide id's kunnen in één query mee.
 */
export async function readExtraInfo(
  client: MondayGraphQLClient,
  itemIds: readonly (string | null)[]
): Promise<ExtraInfoResult> {
  const ids = itemIds.filter((id): id is string => id !== null && id.trim() !== '');
  if (ids.length === 0) {
    return { lines: [], truncated: false };
  }
  const data = await client.query<{
    items: Array<{
      id: string | number;
      updates: Array<{ text_body: string | null; created_at: string }> | null;
    }>;
  }>(
    `query ($ids: [ID!], $limit: Int!) {
       items(ids: $ids) { id updates(limit: $limit) { text_body created_at } }
     }`,
    { ids: [...ids], limit: UPDATE_LIMIT }
  );

  /**
   * `items(ids:)` laat een id dat het niet kan ophalen gewoon wég in plaats van te
   * foutmelden. Zonder deze controle levert een verwijderde of afgeschermde Opportunity
   * precies hetzelfde op als een Opportunity zonder opmerkingen: een lege list.
   */
  const resolved = new Set((data.items ?? []).map((item) => String(item.id)));
  const lost = ids.filter((id) => !resolved.has(id));
  if (lost.length > 0) {
    throw new Error(
      `Briefing: de updates van ${lost.length} van de ${ids.length} items konden niet worden ` +
        `opgehaald (${lost.join(', ')}). Mogelijk verwijderd of niet toegankelijk.`
    );
  }

  const updates: RawUpdate[] = [];
  let truncated = false;
  for (const item of data.items ?? []) {
    const list = item.updates ?? [];
    if (list.length >= UPDATE_LIMIT) {
      truncated = true;
    }
    for (const update of list) {
      updates.push({ textBody: update.text_body, createdAt: update.created_at });
    }
  }
  return collectExtraInfo(updates, { truncated });
}
