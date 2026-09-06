import { TRAINER_COLUMNS } from '@lib/monday/board-config';

/**
 * De e-mailadressen van de trainers, van het trainersbord.
 *
 * Bestaat apart omdat de agenda ze niet heeft: daar staat alleen de relatie. Backoffice
 * heeft het adres nodig om de trainermail door te sturen, en dat het niet goed ingevuld werd
 * is een van de vier reparaties die `04-evaluatierapportage.md` opsomt.
 */

/**
 * Twee kolommen, in volgorde van voorkeur.
 *
 * `e_mail__1` is het persoonlijke adres en `itg_mail__1` het ITG-adres; de tweede is de
 * terugval, precies zoals `board-config.ts` hem beschrijft.
 *
 * **`itgEmail` is optioneel in `TrainerColumnMap`**, dus hij wordt eruit gefilterd als hij er
 * niet is. Zonder dat komt de tekst `undefined` als kolom-id in de bevraging terecht, en
 * Monday laat een onbekend id stil weg — de terugval zou dan bestaan zonder ooit iets te
 * vinden, en dat is niet te zien aan het antwoord.
 */
const EMAIL_COLUMNS: readonly string[] = [TRAINER_COLUMNS.email, TRAINER_COLUMNS.itgEmail].filter(
  (id): id is string => id !== undefined && id !== ''
);

interface EmailCell {
  id: string;
  text?: string | null;
  /** Alleen op e-mailkolommen, via het typed `EmailValue`-fragment. */
  email?: string | null;
}

interface TrainerItem {
  id: string;
  column_values?: EmailCell[] | null;
}

interface TrainerReader {
  query(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<{ items?: TrainerItem[] | null }>;
}

/**
 * Monday's `items(ids:)` levert er stil hoogstens 25.
 *
 * Hier kan dat niet knellen — een training heeft een leadtrainer en hooguit een paar
 * co-trainers — maar het staat er omdat dezelfde stille afkapping elders al een keer een
 * onvolledige uitkomst opleverde die er compleet uitzag.
 */
const MAX_ITEMS = 25;

export async function readTrainerEmails(
  client: TrainerReader,
  itemIds: readonly string[]
): Promise<readonly string[]> {
  if (itemIds.length === 0) {
    return [];
  }
  if (itemIds.length > MAX_ITEMS) {
    throw new Error(
      `${itemIds.length} trainers op één training; \`items(ids:)\` levert er stil hoogstens ` +
        `${MAX_ITEMS}, dus dit moet in stukken gelezen worden.`
    );
  }

  const ids = EMAIL_COLUMNS.map((id) => `"${id}"`).join(', ');
  const data = await client.query(
    `query ($i: [ID!]) { items(ids: $i) { id ` +
      `column_values(ids: [${ids}]) { id text ... on EmailValue { email } } } }`,
    { i: [...itemIds] }
  );

  /**
   * In de volgorde van `itemIds`, en niet in die van het antwoord.
   *
   * De leadtrainer staat als eerste in de mail en hoort ook als eerste in de CC-regel te
   * staan; Monday belooft geen volgorde terug te geven.
   */
  const byId = new Map((data.items ?? []).map((item) => [item.id, item]));
  const adressen: string[] = [];
  for (const id of itemIds) {
    const item = byId.get(id);
    if (item === undefined) {
      continue;
    }
    for (const columnId of EMAIL_COLUMNS) {
      const cel = (item.column_values ?? []).find((c) => c.id === columnId);
      const adres = (cel?.email ?? cel?.text ?? '').trim();
      if (adres !== '') {
        adressen.push(adres);
        break;
      }
    }
  }
  return adressen;
}
