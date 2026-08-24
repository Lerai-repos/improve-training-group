/**
 * De concept-inhoud: de bullets onder het kopje "Concept inhoud" in de briefing.
 *
 * De tekst komt per thema uit Monday (`itg_conceptinhoud` op het Themas-bord), waar de 85
 * skeletten van ITG in staan. Eén ding daarin is variabel: de naam van de organisatie. In
 * ITG's eigen bestand stond die er acht verschillende manieren in — `organisatienaam`,
 * `xx`, `XXX`, `Xx` — omdat een mens hem met de hand moest vervangen. Dirkje: *"In Canva
 * wordt de opmaak gewist en was het daarom niet opvallend dat organisatienaam moest worden
 * aangepast."* Bij het inlezen zijn die acht één token geworden, en hier wordt hij ingevuld.
 *
 * **Het skelet is een voorzet, geen eindtekst.** Gemeten aan ITG's eigen voorbeeldbriefing
 * (Probiblio, Verbindend communiceren): van de twaalf bullets is er één letterlijk gelijk
 * aan het skelet en zijn de andere elf herschreven naar de klant. Vandaar dat de adviseur
 * ze in de app-tab mag overschrijven; zie `resolveConceptInhoud`.
 */

import { notDecided } from './open-issues';

/**
 * De plaatshouder zoals hij in Monday staat.
 *
 * Accolades en niet `+++`, want dat laatste zijn de scheidingstekens van `docx-templates`.
 * Een waarde die daar doorheen gaat wordt niet opnieuw geïnterpreteerd, maar een token dat
 * er hetzelfde uitziet nodigt uit tot verwarring bij de eerstvolgende die dit leest.
 */
export const ORGANISATIE_TOKEN = '{organisatie}';

/**
 * Splitst het tekstveld in bullets.
 *
 * Monday's `long_text` geeft `\n` terug (en soms `\r\n` als er uit Word geplakt is). Lege
 * regels vallen weg: iemand die in Monday een witregel tikt bedoelt geen lege bullet.
 */
export function conceptLines(raw: string): readonly string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Vult de organisatienaam in.
 *
 * Zonder naam wordt de bullet **niet** half afgedrukt. "hoe staat het er nu voor met
 * feedback binnen en binnen deze groep?" leest als een slordige zin en niet als een
 * ontbrekend gegeven, en gaat zo ongemerkt naar de trainer. Daarom komt er dan een
 * zichtbare `«…»`-regel bij in plaats van de bullet.
 *
 * Gemeten op het agendabord: `Bedrijf` is gevuld op 738 van de 756 trainingen (97,6%), dus
 * dit is de uitzondering en niet de regel.
 */
export function fillOrganisatie(
  lines: readonly string[],
  organisatie: string
): readonly string[] {
  const naam = organisatie.trim();
  if (naam !== '') {
    return lines.map((line) => line.split(ORGANISATIE_TOKEN).join(naam));
  }
  const needsName = lines.some((line) => line.includes(ORGANISATIE_TOKEN));
  const kept = lines.filter((line) => !line.includes(ORGANISATIE_TOKEN));
  if (!needsName) {
    return kept;
  }
  return [
    ...kept,
    notDecided(
      'de organisatienaam in de concept-inhoud',
      'Bedrijf is leeg op deze training, dus de bullets die de naam noemen zijn weggelaten'
    ),
  ];
}

/**
 * Wat er uiteindelijk in het document komt.
 *
 * De volgorde is de hele afspraak: **wat de adviseur zelf heeft getypt wint**, anders het
 * skelet van het thema. Niets opgeslagen betekent dus niet "leeg" maar "gebruik het
 * standaardskelet", zodat een verbeterd skelet in Monday elke volgende briefing bereikt in
 * plaats van bevroren te raken op de dag dat iemand de tab opendeed.
 *
 * `undefined` als er geen van beide is: dat is "nog niet aangesloten" en `compose` maakt er
 * de bekende `«…»`-regel van.
 */
export function resolveConceptInhoud(input: {
  readonly themaTekst: string;
  readonly adviseurTekst?: string;
  readonly organisatie: string;
}): readonly string[] | undefined {
  const eigen = (input.adviseurTekst ?? '').trim();
  const bron = eigen !== '' ? eigen : input.themaTekst;
  const lines = conceptLines(bron);
  if (lines.length === 0) {
    return undefined;
  }
  return fillOrganisatie(lines, input.organisatie);
}
