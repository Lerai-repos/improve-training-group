/**
 * Wat het cyclusdocument over de sessies zegt: de regels van de gegevenstabel en de cijfers
 * in de cyclustekst, afgeleid uit de bevestigde sessies en de Opportunity.
 *
 * Gemodelleerd naar Dirkje's eigen voorbeeld (Reade, `ITG vb cyclus Briefing Reade …`,
 * 22-Sep-2026): `Duur: 4 + 3 uur`, `Datum & tijd` met één regel per sessie, `Km. / Reistijd`
 * per sessie plus een totaal, en de rest van de tabel één keer. Sessie 2 stond daar als
 * `N.O.T.K.`, want die was nog niet gepland toen de briefing werd gemaakt — en de trainer
 * moet tóch weten dat er twee sessies komen.
 *
 * **Puur.** Alles wat hier binnenkomt is al gelezen; dit rekent alleen uit wat er komt te staan.
 */

import { formatDateTime, formatDuration, formatTravel, type TravelInput } from './format';

import type { BriefingTraining } from './types';

/** Zo schrijft ITG een sessie die nog niet gepland is; letterlijk uit het Reade-voorbeeld. */
export const NOG_TE_PLANNEN = 'N.O.T.K.';

/** Eén sessie zoals het document haar ziet. `itemId` is `null` voor een nog ongeplande sessie. */
export interface DocumentSessie {
  /** 1-gebaseerd, in de volgorde van de cyclus. */
  readonly nummer: number;
  readonly itemId: string | null;
  readonly datum: string;
  readonly tijden: string;
  readonly locatie: string;
  readonly groepsgrootte: string;
  readonly ieCode: string;
  /** De kolom `Duur` als tekst, voor als de uren er niet uit te halen zijn. */
  readonly duur: string;
  /** Uren van deze sessie, uit `Duur` of uit de Opportunity-variant; `null` als geen van beide. */
  readonly uren: number | null;
}

/** De cijfers voor de cyclustekst: "een cyclus van 4 + 3 uur", "twee sessies". */
export interface CyclusFeiten {
  readonly duur: string;
  readonly aantal: number;
}

/** `4`, `4 uur`, `3,5 uur`, `2.5` → het getal; alles anders (`2x 1 uur`) → `null`. */
function urenUit(duur: string): number | null {
  const match = /^(\d+(?:[,.]\d+)?)\s*(?:uur)?$/i.exec(duur.trim());
  return match === null ? null : Number(match[1].replace(',', '.'));
}

/**
 * De uren per sessie uit `Trainingscyclus?` op de Opportunity.
 *
 * `2x4u` → twee sessies van 4; `8+4u` → 8 en 4; `3x4u` → drie van 4. ITG mag varianten
 * toevoegen, dus dit leest de vorm en niet een vaste lijst. `Nee`, leeg en alles wat niet op
 * een van de twee vormen lijkt is `null`: dan zegt de Opportunity niets over het aantal.
 */
export function parseCyclusVariant(label: string): readonly number[] | null {
  const kaal = label
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(?:uur|u)$/, '');
  const getal = (t: string): number => Number(t.replace(',', '.'));
  const maal = /^(\d+)x(\d+(?:[,.]\d+)?)$/.exec(kaal);
  if (maal !== null) {
    return Array.from({ length: Number(maal[1]) }, () => getal(maal[2]));
  }
  if (/^\d+(?:[,.]\d+)?(?:\+\d+(?:[,.]\d+)?)+$/.test(kaal)) {
    return kaal.split('+').map(getal);
  }
  return null;
}

/**
 * De sessies van het document, of leeg als dit geen cyclusdocument is.
 *
 * Een cyclusdocument is er zodra de training het cycluslabel draagt óf bij een bevestigde
 * cyclus hoort. Zonder bevestigde cyclus is de training zelf sessie 1 — en zegt de Opportunity
 * dat er meer sessies horen te zijn, dan komen die er als `N.O.T.K.` bij. Met een bevestigde
 * cyclus zijn dat haar sessies, op datum, plus wat de Opportunity er nog aan mist.
 */
export function documentSessies(training: BriefingTraining): readonly DocumentSessie[] {
  if (training.cyclus === null && !training.opdrachten.trainingCycle) {
    return [];
  }
  const variant = parseCyclusVariant(training.cyclusVariant) ?? [];
  const bekend: readonly Omit<DocumentSessie, 'nummer'>[] =
    training.cyclus === null
      ? [
          {
            itemId: training.itemId,
            datum: training.datum,
            tijden: training.tijden,
            locatie: training.locatie,
            groepsgrootte: training.groepsgrootte,
            ieCode: training.ieCode,
            duur: training.duur,
            uren: urenUit(training.duur),
          },
        ]
      : training.cyclus.sessies.map((s) => ({
          itemId: s.itemId,
          datum: s.datum,
          tijden: s.tijden,
          locatie: s.locatie,
          groepsgrootte: s.groepsgrootte,
          ieCode: s.ieCode,
          duur: s.duur,
          uren: urenUit(s.duur),
        }));
  const aantal = Math.max(bekend.length, variant.length);
  return Array.from({ length: aantal }, (_, index) => {
    const sessie = bekend[index];
    /** De Opportunity vult aan wat `Duur` niet zegt, maar overschrijft nooit wat er staat. */
    const uren = sessie?.uren ?? variant[index] ?? null;
    return sessie === undefined
      ? {
          nummer: index + 1,
          itemId: null,
          datum: '',
          tijden: '',
          locatie: '',
          groepsgrootte: '',
          ieCode: '',
          duur: '',
          uren,
        }
      : { ...sessie, nummer: index + 1, uren };
  });
}

const urenTekst = (uren: number): string => String(uren).replace('.', ',');

/**
 * `4 + 3 uur`, of `2 x 4 uur` als elke sessie even lang is.
 *
 * Alleen als élke geplande sessie een bekende duur heeft. Anders zou "4 uur" boven een cyclus
 * van twee sessies staan alsof dat het geheel is; dan komt er per sessie een regel met wat
 * `Duur` letterlijk zegt (`Sessie 2: 2x 1 uur`, of leeg — en dat meldt de tab als onvolledig).
 * Een ongeplande sessie zonder variant heeft niets te zeggen en telt hier niet mee.
 */
export function formatCyclusDuur(sessies: readonly DocumentSessie[]): string {
  const gepland = sessies.filter((s) => s.itemId !== null);
  if (gepland.some((s) => s.uren === null)) {
    return perSessie(sessies, (s) => formatDuration(s.duur));
  }
  const uren = sessies.flatMap((s) => (s.uren === null ? [] : [s.uren]));
  if (uren.length === 0) {
    return '';
  }
  if (uren.length > 1 && uren.every((u) => u === uren[0])) {
    return `${uren.length} x ${urenTekst(uren[0])} uur`;
  }
  return `${uren.map(urenTekst).join(' + ')} uur`;
}

/** Of elke geplande sessie een duur in uren heeft; zonder dat kent de cyclustekst geen totaal. */
export function duurBekend(sessies: readonly DocumentSessie[]): boolean {
  return sessies.filter((s) => s.itemId !== null).every((s) => s.uren !== null);
}

const REGEL = '\n';

/** `Sessie 1: …` per regel; een ongeplande sessie is `N.O.T.K.`. */
export function perSessie(
  sessies: readonly DocumentSessie[],
  tekst: (sessie: DocumentSessie) => string
): string {
  return sessies
    .map((s) => `Sessie ${s.nummer}: ${s.itemId === null ? NOG_TE_PLANNEN : tekst(s)}`)
    .join(REGEL);
}

/** `Datum & tijd`: elke sessie op haar eigen regel. */
export function formatCyclusDatumTijd(sessies: readonly DocumentSessie[]): string {
  return perSessie(sessies, (s) => formatDateTime(s.datum, s.tijden));
}

/**
 * Eén waarde als alle geplande sessies dezelfde hebben, anders per sessie.
 *
 * Locatie en groepsgrootte staan bij Reade één keer, want ze zijn hetzelfde. Verschillen ze
 * wél — een cyclus met een tweede dag elders — dan hoort de trainer dat per sessie te lezen.
 * Ongeplande sessies tellen niet mee in de vergelijking. **Een lege waarde telt wél als
 * verschil**: mist sessie 2 haar locatie, dan hoort er "Sessie 2:" met niets erachter te staan,
 * en niet de locatie van sessie 1 alsof die voor allebei geldt. De tab meldt zo'n gat ook
 * (`sessiesOnvolledig`), zodat de briefing niet als klaar de deur uit gaat.
 */
export function eenmaligOfPerSessie(
  sessies: readonly DocumentSessie[],
  waarde: (sessie: DocumentSessie) => string
): string {
  const gepland = sessies.filter((s) => s.itemId !== null);
  const waarden = new Set(gepland.map(waarde));
  if (waarden.size <= 1) {
    return [...waarden][0] ?? '';
  }
  return perSessie(sessies, waarde);
}

/**
 * `Km. / Reistijd` van één ontvanger over de hele cyclus.
 *
 * Reade: *"Per sessie: … / Totaal: 216 km. / 170 min. (80 min. factureren)"*. De
 * factureerbare minuten zijn per sessie boven de drempel, opgeteld — elke reis is een rit.
 * Hetzelfde voor elke sessie geeft één `Per sessie`-regel; verschilt de locatie, dan per
 * sessie. `null` zodra er voor een geplande sessie geen route is: dan is de tabel niet af,
 * net als bij één sessie zonder route.
 */
export function formatCyclusTravel(
  perSessieReis: ReadonlyArray<TravelInput | undefined>
): string | null {
  if (perSessieReis.length === 0 || perSessieReis.some((r) => r === undefined)) {
    return null;
  }
  const reizen = perSessieReis.flatMap((r) => (r === undefined ? [] : [r]));
  const rit = (r: TravelInput): string => formatTravel(r).replace(/Totaal: /g, '');
  const gelijk = reizen.every((r) => rit(r) === rit(reizen[0]));
  const regels = gelijk
    ? [`Per sessie: ${rit(reizen[0])}`]
    : reizen.map((r, index) => `Sessie ${index + 1}: ${rit(r)}`);
  const som = (kies: (r: TravelInput) => number): number =>
    reizen.reduce((acc, r) => acc + kies(r), 0);
  const km = Math.round(som((r) => r.roundTripKm));
  const minuten = Math.round(som((r) => r.roundTripMinutes));
  const factureren = som((r) => Math.max(0, Math.round(r.roundTripMinutes) - r.thresholdMinutes));
  /** Eén keer "Totaal", niet twee (Tim, 22-Sep-2026); de losse briefing houdt ITG's eigen vorm. */
  regels.push(`Totaal: ${km} km. / ${minuten} min. (${factureren} min. factureren)`);
  return regels.join(REGEL);
}

/**
 * De route per sessie voor één ontvanger.
 *
 * Een sessie die nog niet gepland is heeft geen locatie, dus ook geen route. Dirkje telde in
 * het Reade-voorbeeld voor sessie 2 dezelfde rit als voor sessie 1 (216 km voor twee keer
 * 108), en dat is ook de enige verdedigbare aanname: de cyclus is voor dezelfde groep op
 * dezelfde plek, tenzij Monday straks iets anders zegt.
 */
export function reisPerSessie(
  sessies: readonly DocumentSessie[],
  reisVoor: (itemId: string) => TravelInput | undefined
): ReadonlyArray<TravelInput | undefined> {
  const eerste = sessies.find((s) => s.itemId !== null);
  const terugval =
    eerste?.itemId === null || eerste === undefined ? undefined : reisVoor(eerste.itemId);
  return sessies.map((s) => (s.itemId === null ? terugval : reisVoor(s.itemId)));
}

const AANTAL_WOORD: Readonly<Record<number, string>> = {
  2: 'twee',
  3: 'drie',
  4: 'vier',
  5: 'vijf',
  6: 'zes',
};

/** Het aantal sessies voluit, zoals Dirkje het schrijft: "twee sessies". */
export function aantalWoord(aantal: number): string {
  return AANTAL_WOORD[aantal] ?? String(aantal);
}

/** De cijfers voor de cyclustekst, of `null` als het geen cyclusdocument is. */
export function cyclusFeiten(sessies: readonly DocumentSessie[]): CyclusFeiten | null {
  if (sessies.length === 0) {
    return null;
  }
  /** Zonder totaal geen "van … uur" in de tekst: beter niets dan een half getal. */
  return { duur: duurBekend(sessies) ? formatCyclusDuur(sessies) : '', aantal: sessies.length };
}
