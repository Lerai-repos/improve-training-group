/**
 * Alinea's terug in een lang tekstveld van Monday.
 *
 * Monday levert een enter in een long-text-kolom niet als regeleinde maar als twee spaties,
 * in `text` én in `value`. Gemeten 12-Oct-2026 op de Opportunity-achtergrond: 44 teksten, 0
 * met een regeleinde, 118 keer twee of meer spaties na een leesteken. Zonder dit staat in de
 * tab en in het document één lap tekst, en zoeken de werkstudenten waar de volgende alinea
 * begint (Dirkje, 12-Oct-2026).
 *
 * Twee of meer spaties worden dus een nieuwe alinea, behalve vóór een kleine letter: dat is een
 * tikfout midden in een zin ("ongeveer 2  beschikbaar", de enige zo gemeten), geen enter.
 *
 * Daarna de kopjes. Een deel van de teksten heeft géén enkele dubbele spatie (Windgoo: 2000
 * tekens, alles met één spatie), en daar zitten de kopjes met één spatie aan de zin erna vast:
 * "De aanleiding Binnen de winkels…". Eén spatie is in het algemeen niet van een gewone zin te
 * onderscheiden, maar ITG gebruikt een vaste set kopjes; zie `ACHTERGROND_KOPPEN`.
 */
export function herstelAlineas(tekst: string): string {
  return tekst
    .split('\n')
    .flatMap((regel) => regel.split(/ {2,}(?=[^\sa-zà-ÿ])/))
    .flatMap(losKoppen)
    .map((alinea) => alinea.trim())
    .filter((alinea) => alinea !== '')
    .join('\n');
}

/**
 * De kopjes die ITG in de achtergrond gebruikt. Gemeten 12-Oct-2026 over 96 teksten op de
 * Opportunity: `De aanleiding` 43×, `De deelnemersgroep` 27×, `Over de organisatie` 24×,
 * `Organisatie` 17×, `Aanleiding` 16×, `Deelnemers` 15×, `De organisatie` 10×,
 * `De deelnemers` 7×. In elke gecontroleerde vindplaats was het echt een kopje.
 *
 * Langste eerst, zodat `De aanleiding` niet als `Aanleiding` met een los "De" ervoor leest.
 */
const ACHTERGROND_KOPPEN: readonly string[] = [
  'Over de organisatie',
  'De deelnemersgroep',
  'De organisatie',
  'De aanleiding',
  'De deelnemers',
  'Organisatie',
  'Aanleiding',
  'Deelnemers',
];

/** Is deze alinea een van de vaste kopjes, en verder niets? Dan komt hij vet in het document. */
export function isAchtergrondKop(alinea: string): boolean {
  return ACHTERGROND_KOPPEN.includes(alinea.trim());
}

/**
 * Een kopje telt alleen aan het begin van een alinea of direct na een zin, en alleen met een
 * hoofdletter erachter. "naar de aanleiding Binnen" (midden in een zin) en "Organisatie is
 * belangrijk." (kleine letter erachter) blijven zoals ze zijn.
 */
const KOP = new RegExp(
  `(^|[.!?:]\\s+)(${ACHTERGROND_KOPPEN.join('|')}) (?=[A-ZÀ-Ý0-9‘'"(])`,
  'g'
);

function losKoppen(alinea: string): string[] {
  return alinea.replace(KOP, (_, voor: string, kop: string) => `${voor}\n${kop}\n`).split('\n');
}
