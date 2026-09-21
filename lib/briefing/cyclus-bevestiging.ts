/**
 * Wat de adviseur bevestigd heeft over de trainingscycli van één opdracht.
 *
 * Tim, 18-Sep-2026: de regel stelt sessies voor, een mens vinkt aan welke samen één briefing
 * krijgen. Dat antwoord hoort **bij de Opportunity** en niet bij één sessie: onder één opdracht
 * kunnen meerdere cycli staan (Reinaerde heeft er twee), en het antwoord moet blijven staan als
 * de regel later iets anders zou vinden — bijvoorbeeld omdat iemand een trainer wisselt.
 *
 * In KV en niet op een bord, om dezelfde reden als de checklist: dit is invoer van de app, geen
 * administratie van ITG. Zie `itg-briefing-design-decisions`.
 *
 * `beslist` is de reden dat de vraag niet elke keer terugkomt: per sessie staat erin tegen welke
 * andere sessies haar indeling beslist is. Komt er later een sessie bij onder dezelfde opdracht,
 * dan staat die er niet in en stelt de tab de vraag opnieuw — mét die nieuwe sessie erbij.
 *
 * **Dit bestand komt in de browserbundel** (via `cyclus.ts` → `tab.ts` → de tab-hook), dus hier
 * alleen typen en pure functies. De opslag zelf, met `node:crypto` en Redis, staat in
 * `cyclus-store.ts`; die hier importeren breekt `next build`.
 */

import type { Fence } from './checklist-store';

/** Twee jaar: een cyclus kan over de jaarwisseling lopen en blijft daarna leesbaar. */
export const CYCLUS_TTL_MS = 730 * 24 * 60 * 60 * 1000;

/** Geëxporteerd omdat de checklist-store deze sleutel als hek gebruikt. */
export const cyclusStoreKey = (opportunityItemId: string): string =>
  `briefing:cyclus:${opportunityItemId}`;

/**
 * Eén bevestigde cyclus.
 *
 * `anker` is waar de antwoorden STAAN — vastgelegd, niet afgeleid. Afleiden ("de eerste sessie
 * die te schrijven is") ging mis zodra dat verschoof: na een jaarwisseling stonden de antwoorden
 * nog onder de gearchiveerde eerste sessie, terwijl de afleiding een sessie aanwees die hooguit
 * een restant van vóór de cyclus droeg. Nu wijst het record het aan, en verhuist het anker alleen
 * door een vastgelegde verhuizing.
 */
export interface Groep {
  readonly leden: readonly string[];
  readonly anker: string;
}

export interface BevestigdeCycli {
  /** Elke groep is één briefing. Een sessie die in geen groep staat, krijgt haar eigen briefing. */
  readonly groepen: readonly Groep[];
  /**
   * Per sessie: tegen wélke andere sessies haar indeling beslist is.
   *
   * **Per sessie en niet één lijst voor de hele opdracht.** Onder één Opportunity kunnen twee
   * cycli staan; met één gedeelde lijst maakte het bevestigen van cyclus A de sessies van
   * cyclus B "beslist", waarna B zonder vraag als "geen cyclus" op het scherm kwam — een
   * antwoord dat niemand had gegeven.
   */
  readonly beslist: Readonly<Record<string, readonly string[]>>;
  /**
   * Verhuizingen die nog moeten gebeuren: antwoorden die naar een ander item moeten.
   *
   * **Ze staan hier en niet alleen in het geheugen van de aanroeper**, want een indeling
   * wijzigen en de antwoorden meeverhuizen zijn samen één handeling die niet half af mag
   * blijven. Ze worden in dezelfde schrijfactie vastgelegd als de nieuwe indeling; daarna voert
   * wie dan ook ze uit en haalt ze weg. Mislukt dat, dan staat het er de volgende keer nog, en
   * maakt de eerstvolgende lezing van de tab het alsnog af.
   */
  readonly verhuizingen: readonly Verhuizing[];
}

/**
 * Eén verhuizing: kopieer de antwoorden van de eerste bron die ze heeft naar `naar`.
 *
 * `gezaghebbend` is de bron die het wint van wat er al onder `naar` staat: het anker van de groep
 * zoals die wás. Een sessie die lid was van die groep kan een eigen, ouder record dragen van vóór
 * ze meedeed; dat is geen invoer meer maar een restant, en het mag de gedeelde antwoorden niet
 * verdringen zodra die sessie het nieuwe anker wordt.
 */
export interface Verhuizing {
  readonly naar: string;
  readonly bronnen: readonly string[];
  readonly gezaghebbend?: string;
}

/** Het record van een opdracht mét de versie waar een schrijfactie op de checklist op kan hekken. */
export interface CyclusStand {
  readonly stand: BevestigdeCycli | null;
  readonly fence: Fence;
}

export interface CyclusStore {
  read(opportunityItemId: string): Promise<BevestigdeCycli | null>;
  /**
   * Hetzelfde, mét het hek: de sha1 van precies de bytes die gelezen zijn. Wie hieruit afleidt
   * waar antwoorden horen te staan, geeft dat hek mee aan de checklist-store, zodat die
   * schrijfactie niet doorgaat als het record intussen is veranderd.
   */
  readMetFence(opportunityItemId: string): Promise<CyclusStand>;
  /**
   * Lezen, aanpassen en wegschrijven als één geheel.
   *
   * Twee adviseurs die tegelijk elk een eigen cyclus onder dezelfde opdracht bevestigen lezen
   * anders dezelfde stand, en dan wist de laatste schrijfactie de groep van de eerste zonder
   * dat iemand iets merkt.
   *
   * `maak` is **puur**: hij rekent alleen de nieuwe stand uit en schrijft zelf niets weg. Werk
   * met gevolgen buiten dit record — de antwoorden verhuizen — hoort in `verhuizingen`, zodat
   * het bij de stand hoort die de schrijfactie wint en niet bij een poging die verloor.
   */
  update(
    opportunityItemId: string,
    maak: (huidig: BevestigdeCycli | null) => BevestigdeCycli
  ): Promise<{ vorige: BevestigdeCycli | null; volgende: BevestigdeCycli }>;
}

/**
 * De nieuwe stand na een bevestiging vanaf `itemId`.
 *
 * `gekozen` zijn de aangevinkte sessies inclusief de training zelf; `getoond` is alles wat er op
 * het scherm stond, zodat de vraag daarna niet terugkomt.
 *
 * Twee dingen gebeuren er, en het verschil doet ertoe: de groep waar deze training in zat wordt
 * vervangen — ook een sessie die eruit gevinkt is, staat er daarna niet meer in — en een
 * aangevinkte sessie wordt uit een ándere groep gehaald, want ze kan maar in één briefing zitten.
 * Een groep waar niets van dit alles mee gebeurt blijft staan: onder één opdracht kunnen twee
 * cycli leven (Reinaerde), en bevestigen vanaf de ene mag de andere niet slopen.
 */
export function metBevestiging(
  huidig: BevestigdeCycli | null,
  itemId: string,
  gekozen: readonly string[],
  getoond: readonly string[],
  /** Waar de antwoorden van een groep komen te staan: de eerste sessie die te schrijven is. */
  ankerVoor: (leden: readonly string[]) => string
): BevestigdeCycli {
  const gekozenSet = new Set([...gekozen, itemId]);
  const overig: Groep[] = (huidig?.groepen ?? [])
    .filter((groep) => !groep.leden.includes(itemId))
    .map((groep) => {
      const leden = groep.leden.filter((id) => !gekozenSet.has(id));
      /**
       * Verliest een groep haar anker aan deze keuze, dan krijgt de rest een nieuw anker en
       * volgt een verhuizing daarheen (`andereCycli`). Blijft het anker, dan verandert er niets.
       */
      return { leden, anker: leden.includes(groep.anker) ? groep.anker : ankerVoor(leden) };
    })
    .filter((groep) => groep.leden.length > 1);
  const nieuw = [...gekozenSet].sort();
  const groepen: Groep[] =
    nieuw.length > 1 ? [...overig, { leden: nieuw, anker: ankerVoor(nieuw) }] : overig;

  /**
   * Beslist is alleen wie er in deze groep zit. Bevestigen geldt voor de hele groep — wie
   * sessie 2 aanvinkt beantwoordt de vraag ook voor sessie 2 — maar zegt niets over een sessie
   * die de adviseur juist uit liet staan: die kan zelf nog bij een andere cyclus horen.
   */
  const beslist: Record<string, readonly string[]> = { ...(huidig?.beslist ?? {}) };
  /**
   * Wie door deze wijziging zonder groep achterblijft, moet opnieuw gevraagd worden.
   *
   * Voorbeeld: `[c, d]` was bevestigd en nu wordt `c` bij een andere cyclus gevinkt. Dan valt
   * `d` uit zijn groep, maar zijn oude antwoord staat er nog — en dan meldt de tab op `d`
   * doodleuk "geen cyclus", terwijl niemand dat over `d` heeft gezegd. Zijn beslissing vervalt
   * dus met zijn groep.
   */
  const houdtGroep = new Set(groepen.flatMap((groep) => groep.leden));
  const uitElkaar = (huidig?.groepen ?? [])
    .filter((groep) => groep.leden.includes(itemId) || groep.leden.some((id) => gekozenSet.has(id)))
    .flatMap((groep) => groep.leden);
  for (const id of uitElkaar) {
    if (!houdtGroep.has(id)) {
      delete beslist[id];
    }
  }

  for (const id of gekozenSet) {
    beslist[id] = [...new Set(getoond)].sort();
  }
  return { groepen, beslist, verhuizingen: huidig?.verhuizingen ?? [] };
}

/** De groep waar een sessie in zit, of `null`. */
export function groepVan(stand: BevestigdeCycli | null, itemId: string): Groep | null {
  return stand?.groepen.find((groep) => groep.leden.includes(itemId)) ?? null;
}

/**
 * Dezelfde stand, met het anker van één groep verplaatst.
 *
 * Voor de jaarwisseling: het anker staat op een bord dat gearchiveerd is en is daar niet meer te
 * beschrijven. De verhuizing die erbij hoort legt de aanroeper vast met `metVerhuizingen`.
 */
export function metAnker(
  stand: BevestigdeCycli,
  leden: readonly string[],
  anker: string
): BevestigdeCycli {
  const sleutel = [...leden].sort().join(',');
  return {
    ...stand,
    groepen: stand.groepen.map((groep) =>
      [...groep.leden].sort().join(',') === sleutel ? { ...groep, anker } : groep
    ),
  };
}

/** Dezelfde stand, met de verhuizingen die bij deze wijziging horen erbij. */
export function metVerhuizingen(
  stand: BevestigdeCycli,
  verhuizingen: readonly Verhuizing[]
): BevestigdeCycli {
  const nieuw = verhuizingen.filter((v) => v.bronnen.some((bron) => bron !== v.naar));
  return { ...stand, verhuizingen: [...stand.verhuizingen, ...nieuw] };
}

/** Dezelfde stand, zonder de verhuizingen die gedaan zijn. */
export function zonderVerhuizingen(
  stand: BevestigdeCycli,
  gedaan: readonly Verhuizing[]
): BevestigdeCycli {
  const sleutels = new Set(gedaan.map(sleutelVan));
  return { ...stand, verhuizingen: stand.verhuizingen.filter((v) => !sleutels.has(sleutelVan(v))) };
}

const sleutelVan = (v: Verhuizing): string =>
  `${v.naar}<${[...v.bronnen].sort().join(',')}<${v.gezaghebbend ?? ''}`;
