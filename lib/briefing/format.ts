/**
 * De opmaak van de gegevenstabel: van wat Monday teruggeeft naar wat er in het document staat.
 *
 * Elke regel hier is afgeleid uit twee bronnen tegelijk, en dat is met opzet:
 *
 * 1. **De voorbeeldbriefing** `2.0 ITG vb Briefing Probiblio …docx` — de zestien rijen van
 *    die tabel zijn de enige plek waar de gewenste opmaak letterlijk staat.
 * 2. **De volledige live kolom** — alle 823 trainingen van het agendabord, niet een steekproef.
 *
 * Dat tweede is waar de meeste regels hieronder vandaan komen. De voorbeeldbriefing laat
 * `Duur: 3 uur` zien bij een Monday-waarde `3`, wat eruitziet als "plak er `uur` achter".
 * Over de hele kolom staan er ook `2x 1 uur`, `3 x 45 min` en `2 - 2,5 uur`, en daar levert
 * die regel `2x 1 uur uur` en `3 x 45 min uur` op. Vandaar dat vrijwel elke functie hier
 * eerst kijkt of de waarde het patroon is dat we kennen, en anders **onveranderd doorgeeft**.
 *
 * Onveranderd doorgeven is altijd het veilige antwoord: een lelijke maar kloppende regel is
 * beter dan een nette regel die iets anders beweert dan de adviseur heeft ingevuld.
 */

import { formatDutchDate } from './deadline';
import { notDecided } from './open-issues';

/** Een getal zoals ITG het schrijft: `3`, `3,5`, `2.5`. Niets anders eromheen. */
const PURE_NUMBER = /^\d+(?:[,.]\d+)?$/;

/** Een aantal of een bereik: `15`, `10-20`, `20 - 25`. */
const NUMBER_OR_RANGE = /^\d+(?:\s*-\s*\d+)?$/;

/**
 * `3` wordt `3 uur`; `2x 1 uur` blijft `2x 1 uur`.
 *
 * Gemeten over de kolom `Duur` (`dup__of_tijden`): 61 verschillende waarden. De meeste
 * schrijven de eenheid al zelf (`2,5 uur`, `7,5 uur`), sommige zijn een kale opgave (`3`,
 * `4`, `3,5`) en een flinke staart is een samenstelling (`2x 1 uur`, `1,5 uur x 4`,
 * `3 x 45 min`, `2 - 2,5 uur`). Alleen de kale opgave krijgt er `uur` bij.
 */
export function formatDuration(raw: string): string {
  const value = raw.trim();
  if (value === '' || !PURE_NUMBER.test(value)) {
    return value;
  }
  return `${value} uur`;
}

/**
 * `24 maart 2026; 09:30 - 12:30 uur` uit de kolommen `Datum` en `Tijden`.
 *
 * De `Tijden`-kolom is vrije tekst. Herkennen we er een begin- en eindtijd in, dan
 * normaliseren we naar `09:30 - 12:30`; herkennen we dat niet, dan gaat de tekst er
 * letterlijk in. Zonder datum is er geen regel — dan valt de rij leeg, en `Datum` staat al
 * als verplicht veld in `missing`.
 */
export function formatDateTime(datum: string, tijden: string): string {
  const date = formatDutchDate(datum);
  if (date === '') {
    return '';
  }
  const times = tijden.trim();
  if (times === '') {
    return date;
  }
  const range = /^(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})$/.exec(times);
  if (range === null) {
    return `${date}; ${times}`;
  }
  const pad = (h: string, m: string): string => `${h.padStart(2, '0')}:${m}`;
  return `${date}; ${pad(range[1], range[2])} - ${pad(range[3], range[4])} uur`;
}

/**
 * `10-20` wordt `± 10-20 deelnemers`; `max 15` wordt `max 15 deelnemers`;
 * `3 groepen à 10 deelnemers` blijft zoals het is.
 *
 * Dit veld is het rommeligste van de tabel: 215 verschillende waarden over 823 trainingen,
 * waarvan `15`, `max 15`, `Max. 15`, `max. 15` en `Max 15` allemaal apart voorkomen. De
 * `±` uit de voorbeeldbriefing hoort bij een kaal aantal — voor `max 15` zou `± max 15`
 * onzin zijn, en bij een waarde die het woord al bevat zou `deelnemers` er twee keer staan.
 */
export function formatGroupSize(raw: string): string {
  const value = raw.trim();
  if (value === '') {
    return '';
  }
  if (/deelnemer/i.test(value)) {
    return value;
  }
  if (NUMBER_OR_RANGE.test(value)) {
    return `± ${value.replace(/\s*-\s*/, '-')} deelnemers`;
  }
  return `${value} deelnemers`;
}

/**
 * De taalcodes van het bord, voluit.
 *
 * Gemeten: precies vier waarden over 823 trainingen — `NL` (719), `ENG` (78), `NL + ENG`
 * (12) en leeg (14). Een gesloten lijstje dus, maar onbekende waarden gaan er alsnog
 * onveranderd in: een nieuwe code moet zichtbaar zijn in de briefing, niet weggepoetst.
 */
export function formatLanguage(raw: string): string {
  const value = raw.trim();
  const words: Record<string, string> = {
    NL: 'Nederlands',
    ENG: 'Engels',
    EN: 'Engels',
    'NL + ENG': 'Nederlands + Engels',
  };
  return words[value.toUpperCase()] ?? value;
}

/**
 * De statuswaarde van `Call` (`status3`), in de zin die de trainer leest.
 *
 * Dirkje's opmerking bij dit veld: *"belangrijk, als het Via Teams is, dan aub de volgende
 * tekst: Via Teams, let op: gebruik ITG-account."*
 *
 * Gemeten waarden: `Telefoon` (284), `Teams` (269), `Niet nodig` (136), `Proces klaar`
 * (112) en `klantcontact` (22). De voorbeeldbriefing zet `Telefoon` om naar `Telefonisch
 * contact`; de andere drie komen in die briefing niet voor en gaan onveranderd mee.
 */
export function formatClientContact(raw: string): string {
  const value = raw.trim();
  if (value.toLowerCase() === 'teams') {
    return 'Via Teams, let op: gebruik ITG-account';
  }
  if (value.toLowerCase() === 'telefoon') {
    return 'Telefonisch contact';
  }
  return value;
}

/**
 * De `QR`-kolom (`dup__of_cert`) omgezet naar ja of nee.
 *
 * LET OP: dit is een werkstroomkolom, geen ja/nee-veld. De waarden zijn `Geen QR (deze
 * sessie)` (461), `Verzonden` (113), `Aanmaken` (94), `Staat klaar` (67), `NL Aanmaken`
 * (58), `0. NOTK` (17) en `EN Aanmaken` (13) — dat zijn stappen in het proces van het
 * maken van de QR-code, niet het antwoord op "wordt er geëvalueerd".
 *
 * Drie uitkomsten, en de derde is het punt:
 *
 * | Waarde | Rij in de briefing |
 * |---|---|
 * | `Geen QR (deze sessie)` | `Nee` — te staven met de voorbeeldbriefing |
 * | elke stap die een QR-code oplevert | `Ja, gebruik de QR code` |
 * | `0. NOTK`, of iets onbekends | **niets stelligs** |
 *
 * `NOTK` betekent nog te kennen: de keuze is nog niet gemaakt. Daar `Ja, gebruik de QR
 * code` van maken is geen aanname maar een instructie — de trainer gaat dan aan het eind
 * van de sessie een code ophangen die niet bestaat. Voor die 17 trainingen komt er dus een
 * zichtbare openstaande regel in het document en die haalt `openIssues`.
 *
 * Hetzelfde geldt voor elke waarde die wij niet kennen. De ja-tak werkt met een **witte
 * lijst**: ITG beheert deze statuskolom zelf, en een nieuwe of hernoemde waarde mag niet
 * stilzwijgend als "ja" gelezen worden.
 *
 * **De ja/nee-regel zelf moet Dirkje nog bevestigen.**
 */
const GEEN_QR = /geen qr/i;

/**
 * De werkstroomwaarden die betekenen dat er wél een QR-code komt.
 *
 * Een witte lijst en geen "alles behalve", omdat dit een Monday-statuskolom is die ITG zelf
 * beheert. Zetten zij er morgen `Geannuleerd` of `Nog beslissen` bij, dan zou een
 * alles-behalve-regel de trainer opdragen een code te gebruiken die niet bestaat. Nu levert
 * een onbekende waarde een zichtbare openstaande regel op.
 *
 * Gemeten over 823 trainingen: dit zijn alle voorkomende waarden op `Geen QR (deze sessie)`
 * (461) en `0. NOTK` (17) na.
 */
const QR_WORDT_GEMAAKT: readonly string[] = [
  'Verzonden',
  'Aanmaken',
  'Staat klaar',
  'NL Aanmaken',
  'EN Aanmaken',
];

export function formatEvaluation(raw: string): string {
  const value = raw.trim();
  if (value === '') {
    return '';
  }
  if (GEEN_QR.test(value)) {
    return 'Nee';
  }
  if (QR_WORDT_GEMAAKT.some((state) => state.toLowerCase() === value.toLowerCase())) {
    return 'Ja, gebruik de QR code';
  }
  return notDecided('evaluatie deelnemers', `de QR-kolom staat op "${value}"`);
}

/**
 * De IE-code, of `Geen` als hij ontbreekt.
 *
 * 518 van de 823 trainingen hebben er geen. De voorbeeldbriefing is er zo een en schrijft
 * `Geen` — een lege cel zou lezen alsof iemand het vergeten is.
 */
export function formatIeCode(raw: string): string {
  const value = raw.trim();
  return value === '' ? 'Geen' : value;
}

/** Wat er achter de materialen-deadline staat, letterlijk uit de voorbeeldbriefing. */
export const MATERIALS_SUFFIX = '(bijv. PowerPoint)';

/** Km en reistijd van de toegewezen trainer, retour. */
export interface TravelInput {
  readonly roundTripKm: number;
  readonly roundTripMinutes: number;
  /** Minuten die niet gefactureerd worden; komt uit de instellingen, niet uit code. */
  readonly thresholdMinutes: number;
}

/**
 * `Totaal: 126 km. / Totaal: 100 min. (10 min. factureren)`.
 *
 * Het deel tussen haakjes is het aantal minuten bóven de drempel; blijft de reis eronder,
 * dan valt het weg in plaats van `(0 min. factureren)` af te drukken.
 */
export function formatTravel(reis: TravelInput): string {
  const km = Math.round(reis.roundTripKm);
  const minutes = Math.round(reis.roundTripMinutes);
  const over = Math.max(0, minutes - reis.thresholdMinutes);
  const base = `Totaal: ${km} km. / Totaal: ${minutes} min.`;
  return over === 0 ? base : `${base} (${over} min. factureren)`;
}
