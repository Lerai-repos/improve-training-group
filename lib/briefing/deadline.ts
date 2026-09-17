/**
 * `Materialen uiterlijk op` — wanneer de trainer zijn PowerPoint moet aanleveren.
 *
 * Nieuw in de v2.0-briefing (Dirkje, 9-Aug-2026). Haar eigen omschrijving:
 *
 * > powerpoints of andere materialen moeten door de trainer uiterlijk 72 uur van tevoren
 * > gestuurd worden, LET OP gaat over 72 uur op werkdagen. zaterdag en zondag tellen dus
 * > niet mee in deze 72 uur.
 *
 * 72 uur waarin een weekenddag niets bijdraagt is precies **drie werkdagen terug**, en
 * sinds 17-Sep-2026 altijd om **09:00**. Eerst hield de deadline de begintijd van de
 * training aan; Dirkje vroeg om een vast tijdstip. Haar eigen agendakolom rekent met
 * `WORKDAY({datum}, -3)`, dezelfde dag als hier.
 *
 * **Feestdagen tellen wél mee.** Dat is een keuze, geen omissie: ITG heeft geen
 * feestdagenlijst in Monday, en er een verzinnen zou de deadline stilletjes verschuiven
 * op een manier die niemand kan controleren. Zodra ze er een leveren hoort die hier.
 */

/** Zaterdag en zondag in `Date#getUTCDay`. */
const SATURDAY = 6;
const SUNDAY = 0;

/** Het vaste tijdstip van de deadline (Dirkje, 17-Sep-2026). */
const DEADLINE_TIME = '09:00';

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
  'januari',
  'februari',
  'maart',
  'april',
  'mei',
  'juni',
  'juli',
  'augustus',
  'september',
  'oktober',
  'november',
  'december',
];

/**
 * De deadline, of `null` wanneer de training geen bruikbare datum heeft.
 *
 * Null is een echt antwoord: de rij valt dan uit de briefing in plaats van er een
 * plausibele datum in te zetten die op niets slaat.
 */
export function materialsDeadline(input: {
  datum: string | null | undefined;
}): MaterialsDeadline | null {
  const start = parseIsoDate(input.datum);
  if (start === null) {
    return null;
  }
  const deadline = workingDaysBefore(start, WORKING_DAYS_BEFORE);
  return {
    date: deadline.toISOString().slice(0, 10),
    time: DEADLINE_TIME,
  };
}

/**
 * `24 maart 2026` uit `2026-03-24`. Leeg bij alles wat geen ISO-datum is.
 *
 * Staat hier omdat de maandnamen hier al stonden; de gegevenstabel schrijft de
 * trainingsdatum in exact dezelfde opmaak als de materialen-deadline.
 */
export function formatDutchDate(iso: string | null | undefined): string {
  const date = parseIsoDate(iso);
  if (date === null) {
    return '';
  }
  const [year, month, day] = (iso ?? '').trim().split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/** `19 maart 2026; 09:30 uur`, exact de opmaak uit de v2.0-briefing. */
export function formatDeadline(deadline: MaterialsDeadline | null): string {
  if (deadline === null) {
    return '';
  }
  const written = formatDutchDate(deadline.date);
  return deadline.time === '' ? written : `${written}; ${deadline.time} uur`;
}
