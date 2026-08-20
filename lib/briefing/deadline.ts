/**
 * `Materialen uiterlijk op` — wanneer de trainer zijn PowerPoint moet aanleveren.
 *
 * Nieuw in de v2.0-briefing (Dirkje, 9-Aug-2026). Haar eigen omschrijving:
 *
 * > powerpoints of andere materialen moeten door de trainer uiterlijk 72 uur van tevoren
 * > gestuurd worden, LET OP gaat over 72 uur op werkdagen. zaterdag en zondag tellen dus
 * > niet mee in deze 72 uur.
 *
 * 72 uur waarin een weekenddag niets bijdraagt is precies **drie werkdagen terug op
 * hetzelfde tijdstip**. Geverifieerd tegen het enige uitgewerkte voorbeeld dat we hebben:
 * de training van dinsdag 24 maart 2026 09:30 levert donderdag 19 maart 09:30 op, en dat
 * is wat er in haar document staat.
 *
 * **Feestdagen tellen wél mee.** Dat is een keuze, geen omissie: ITG heeft geen
 * feestdagenlijst in Monday, en er een verzinnen zou de deadline stilletjes verschuiven
 * op een manier die niemand kan controleren. Zodra ze er een leveren hoort die hier.
 */

/** Zaterdag en zondag in `Date#getUTCDay`. */
const SATURDAY = 6;
const SUNDAY = 0;

/** 72 uur, uitgedrukt in werkdagen van 24 uur. */
export const WORKING_DAYS_BEFORE = 3;

export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === SATURDAY || day === SUNDAY;
}

/**
 * `workingDays` werkdagen vóór `start`, op hetzelfde tijdstip.
 *
 * Rekent in UTC en stapt per hele dag, zodat zomertijd de klok niet verzet: 09:30 blijft
 * 09:30. De datum komt als `YYYY-MM-DD` uit Monday en het tijdstip als losse tekst, dus er
 * is geen tijdzone in het spel — en die er zelf bij verzinnen zou de deadline een uur
 * kunnen verschuiven rond de overgang in maart en oktober.
 */
export function workingDaysBefore(start: Date, workingDays: number): Date {
  const out = new Date(start.getTime());
  let remaining = workingDays;
  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() - 1);
    if (!isWeekend(out)) {
      remaining -= 1;
    }
  }
  return out;
}

/**
 * `YYYY-MM-DD` naar een Date, of null.
 *
 * De vormcontrole alleen is niet genoeg: `2026-02-30` past op het patroon, en JavaScript
 * rolt dat stilzwijgend door naar 2 maart in plaats van NaN op te leveren. Dan zou hier
 * een keurige deadline van 25 februari uitkomen voor een datum die niet bestaat — precies
 * het soort plausibele fout dat niemand opmerkt. Daarom rekenen we terug en eisen we dat
 * we op dezelfde datum uitkomen.
 */
export function parseIsoDate(raw: string | null | undefined): Date | null {
  const value = (raw ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return null;
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return date;
}

export interface MaterialsDeadline {
  /** `YYYY-MM-DD`, voor tests en voor opslag. */
  readonly date: string;
  /** `HH:MM`, overgenomen van de training. Leeg als de training geen tijd heeft. */
  readonly time: string;
}

const MONTHS = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
];

/**
 * De starttijd uit Monday's `Tijden`-kolom, die vrije tekst is.
 *
 * Reële waarden zijn `09:30 - 12:30`, `9:30-12:30` en `09:30`. We nemen het eerste
 * tijdstip dat we herkennen en normaliseren naar `HH:MM`. Herkennen we niets, dan is het
 * antwoord `null` en niet een verzonnen middernacht — een deadline op 00:00 leest als een
 * echte afspraak terwijl niemand hem heeft gezet.
 */
export function parseStartTime(tijden: string | null | undefined): string | null {
  if (typeof tijden !== 'string') {
    return null;
  }
  const match = /(\d{1,2})[:.](\d{2})/.exec(tijden);
  if (match === null) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * De deadline, of `null` wanneer de training geen bruikbare datum heeft.
 *
 * Null is een echt antwoord: de rij valt dan uit de briefing in plaats van er een
 * plausibele datum in te zetten die op niets slaat.
 */
export function materialsDeadline(input: {
  datum: string | null | undefined;
  tijden: string | null | undefined;
}): MaterialsDeadline | null {
  const start = parseIsoDate(input.datum);
  if (start === null) {
    return null;
  }
  const deadline = workingDaysBefore(start, WORKING_DAYS_BEFORE);
  return {
    date: deadline.toISOString().slice(0, 10),
    time: parseStartTime(input.tijden) ?? '',
  };
}

/** `19 maart 2026; 09:30 uur`, exact de opmaak uit de v2.0-briefing. */
export function formatDeadline(deadline: MaterialsDeadline | null): string {
  if (deadline === null) {
    return '';
  }
  const [year, month, day] = deadline.date.split('-');
  const written = `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
  return deadline.time === '' ? written : `${written}; ${deadline.time} uur`;
}
