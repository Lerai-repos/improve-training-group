/**
 * De bevestiging van een trainingscyclus: wat er gebeurt als de adviseur op Bevestigen drukt.
 *
 * Apart van de route, want hier zitten drie beslissingen die een test verdienen: mag dit item
 * überhaupt gebundeld worden, horen de aangevinkte sessies wel bij deze opdracht, en wat
 * gebeurt er met de antwoorden die al onder een ándere sessie stonden.
 *
 * Dat laatste is het lastigste stuk. De indeling wijzigen en de antwoorden meeverhuizen zijn
 * samen één handeling: waar ze stáán is alleen te weten zolang de vorige indeling er nog is.
 * Daarom worden de verhuizingen mét de nieuwe indeling weggeschreven en daarna uitgevoerd —
 * zie `cyclus-antwoorden.ts`.
 */

import { bepaalCyclusKeuze, schrijfbaarAnker, type CyclusKandidaat } from './cyclus';
import { voerVerhuizingenUit } from './cyclus-antwoorden';
import {
  groepVan,
  metBevestiging,
  metVerhuizingen,
  type BevestigdeCycli,
  type CyclusStore,
  type Verhuizing,
} from './cyclus-bevestiging';

import type { ChecklistStore } from './checklist-store';
import type { BriefingTraining } from './types';

export interface BevestigCyclusDeps {
  readTraining(): Promise<BriefingTraining>;
  readKandidaten(training: BriefingTraining): Promise<readonly CyclusKandidaat[]>;
  readonly cycli: CyclusStore;
  readonly checklists: ChecklistStore;
}

export type BevestigCyclusUitkomst =
  | { readonly kind: 'ok'; readonly training: BriefingTraining }
  /** De aanvraag klopt niet met wat er op het bord staat; opnieuw proberen helpt niet. */
  | { readonly kind: 'geweigerd'; readonly message: string };

export interface BevestigCyclusInput {
  readonly itemId: string;
  /** De aangevinkte sessies. Leeg = "dit is geen cyclus". */
  readonly gekozen: readonly string[];
  /**
   * De sessies die de adviseur op het scherm hád. Alleen die gelden als beoordeeld: een sessie
   * die ná het laden van de tab aan de opdracht is gekoppeld heeft hij nooit gezien, en daar mag
   * de vraag dus niet stil voor dichtgaan.
   */
  readonly getoond: readonly string[];
}

export async function bevestigCyclus(
  deps: BevestigCyclusDeps,
  input: BevestigCyclusInput
): Promise<BevestigCyclusUitkomst> {
  const training = await deps.readTraining();
  const kandidaten = await deps.readKandidaten(training);
  if (kandidaten.length === 0 || training.opportunityItemId === null) {
    return {
      kind: 'geweigerd',
      message:
        'Voor deze training valt niets te bundelen: er staan geen andere sessies onder ' +
        'dezelfde opdracht met een trainingscyclus.',
    };
  }

  /**
   * Alleen sessies die we zélf hebben gevonden. Het scherm stuurt item-ids terug, en zonder
   * deze toets zou een willekeurig id in de bevestiging belanden — en straks in een briefing
   * die sessies van een andere klant zou bundelen.
   */
  const bekend = new Set(kandidaten.map((k) => k.itemId));
  const onbekend = input.gekozen.filter((id) => !bekend.has(id));
  if (onbekend.length > 0) {
    return {
      kind: 'geweigerd',
      message: `Deze sessies horen niet bij deze opdracht: ${onbekend.join(', ')}.`,
    };
  }
  /** Aanvinken wat je niet gezien hebt kan niet; dan klopt het scherm niet met het verzoek. */
  const nietGetoond = input.gekozen.filter((id) => !input.getoond.includes(id));
  if (nietGetoond.length > 0) {
    return {
      kind: 'geweigerd',
      message: `Deze sessies stonden niet op het scherm: ${nietGetoond.join(', ')}.`,
    };
  }

  /**
   * Beoordeeld is wat op het scherm stond én nu nog bestaat. Niet wat er nú onder de opdracht
   * hangt: is er intussen een sessie bij gekomen, dan blijft de vraag daarvoor open.
   */
  const getoond = input.getoond.filter((id) => bekend.has(id));
  const opportunity = training.opportunityItemId;

  /**
   * Eerst afmaken wat er nog openstond; anders rekenen we met antwoorden die nog moeten landen.
   */
  await voerVerhuizingenUit(deps.cycli, deps.checklists, opportunity);

  /**
   * De nieuwe indeling én de verhuizingen die daarbij horen, in één schrijfactie.
   *
   * Dit blok rekent alleen maar uit; het raakt niets aan. Dat is het hele punt: waar de
   * antwoorden staan hangt af van de indeling die vervangen wordt, en die kan tussen lezen en
   * schrijven veranderd zijn omdat een collega net een andere cyclus bevestigde. `update` draait
   * het dan opnieuw met de stand die werkelijk wordt vervangen, en pas de versie die de
   * schrijfactie wint laat verhuizingen achter. Een poging die verliest laat niets achter.
   */
  const ankerVoor = (leden: readonly string[]): string =>
    schrijfbaarAnker(leden, kandidaten) ?? [...leden].sort()[0];
  const { volgende } = await deps.cycli.update(opportunity, (huidig) => {
    const straks = metBevestiging(huidig, input.itemId, input.gekozen, getoond, ankerVoor);
    return metVerhuizingen(straks, [
      ...andereCycli(huidig, straks, input),
      eigenCyclus(huidig, straks, input),
      ...verlatendeLeden(huidig, straks, input),
    ]);
  });

  /**
   * En meteen uitvoeren. Lukt dat niet, dan werpt deze aanroep — maar de opdracht staat in het
   * record, dus de eerstvolgende lezing van de tab maakt het af. Ook een kopie die door een
   * gelijktijdige wijziging werd tegengehouden telt als niet gelukt: de tab laadt dan opnieuw.
   */
  const uitgevoerd = await voerVerhuizingenUit(deps.cycli, deps.checklists, opportunity);
  if (uitgevoerd.opnieuw) {
    throw new Error(
      'De cyclus is bevestigd, maar de antwoorden zijn nog niet verplaatst omdat een collega ' +
        'tegelijk iets wijzigde; laad de tab opnieuw.'
    );
  }

  const bevestigd: BriefingTraining = {
    ...training,
    ...cyclusVan(input.itemId, kandidaten, volgende),
  };
  return { kind: 'ok', training: bevestigd };
}

/**
 * Waar de antwoorden van DEZE cyclus heen moeten.
 *
 * Naar het anker van de nieuwe groep, zoals het record dat nu vastlegt. Bronnen: dat anker zelf,
 * het anker van de groep zoals hij wás (bij `[A, B]` → `[B, C]` staan ze onder A, buiten de
 * nieuwe groep), en de sessie waar de adviseur zit.
 *
 * Wie is gezaghebbend als er onder het nieuwe anker al iets staat? Bestond de cyclus al, dan haar
 * vastgelegde anker: wat er onder een ander lid staat is een restant van vóór de cyclus, en de
 * gedeelde antwoorden winnen. Is dit de eerste bevestiging, dan de sessie waar de adviseur zit —
 * hij heeft zojuist op sessie 2 zijn programma getypt; wat er onder sessie 1 staat is een oude
 * losse briefing en mag zijn werk niet verdringen, laat staan dat het daarna als restant wordt
 * opgeruimd.
 */
function eigenCyclus(
  huidig: BevestigdeCycli | null,
  volgende: BevestigdeCycli,
  input: { readonly itemId: string }
): Verhuizing {
  const nieuw = groepVan(volgende, input.itemId);
  const naar = nieuw?.anker ?? input.itemId;
  const vorige = groepVan(huidig, input.itemId);
  const gezaghebbend = vorige === null ? input.itemId : vorige.anker;
  return {
    naar,
    bronnen: [gezaghebbend, ...(nieuw?.leden ?? []), ...(vorige?.leden ?? [])],
    ...(gezaghebbend !== naar ? { gezaghebbend } : {}),
  };
}

/**
 * De leden die door deze bevestiging uit de eigen groep vallen, krijgen de antwoorden mee.
 *
 * Wordt `[A, B, C]` vanaf A `[A, B]`, dan wordt C een losse training. Zijn eigen record is bij het
 * opruimen al een grafsteen geworden — de cyclus had immers één levend record, onder het anker —
 * of het is nog een restant van vóór de cyclus. In beide gevallen wint het vastgelegde anker van
 * de oude groep: dáár staan de gedeelde antwoorden.
 */
function verlatendeLeden(
  huidig: BevestigdeCycli | null,
  volgende: BevestigdeCycli,
  input: { readonly itemId: string }
): Verhuizing[] {
  const vorige = groepVan(huidig, input.itemId);
  if (vorige === null) {
    return [];
  }
  const straksInEenGroep = new Set(volgende.groepen.flatMap((groep) => groep.leden));
  return vorige.leden
    /** De eigen sessie loopt via `eigenCyclus`; wie nu in een groep zit heeft daar zijn anker. */
    .filter((id) => id !== input.itemId && !straksInEenGroep.has(id) && id !== vorige.anker)
    .map((id) => ({ naar: id, bronnen: [vorige.anker], gezaghebbend: vorige.anker }));
}

/**
 * De antwoorden van de ándere cycli die door deze bevestiging veranderen.
 *
 * Staan `[A, B]` en `[C, D]` vast en wordt vanaf A `[A, B, C]` bevestigd, dan raakt D zijn groep
 * kwijt — terwijl het programma van die cyclus onder C stond, en C nu bij een andere briefing
 * hoort. Zonder deze stap is dat programma voor niemand meer te zien.
 *
 * Bron is het vastgelegde anker van die groep. Doel: het nieuwe anker van wat er overblijft (dat
 * `metBevestiging` al heeft toegewezen), of de sessie die alleen achterblijft. Kopiëren, niet
 * verplaatsen: de nieuwe groep van C houdt wat hij heeft.
 */
function andereCycli(
  huidig: BevestigdeCycli | null,
  volgende: BevestigdeCycli,
  input: { readonly itemId: string; readonly gekozen: readonly string[] }
): Verhuizing[] {
  const gekozen = new Set([...input.gekozen, input.itemId]);
  const opdrachten: Verhuizing[] = [];
  for (const groep of huidig?.groepen ?? []) {
    /** De eigen groep loopt via `eigenCyclus`; deze stap gaat over de andere. */
    if (groep.leden.includes(input.itemId) || !groep.leden.some((id) => gekozen.has(id))) {
      continue;
    }
    const rest = groep.leden.filter((id) => !gekozen.has(id));
    const overgebleven = volgende.groepen.find(
      (g) => [...g.leden].sort().join(',') === [...rest].sort().join(',')
    );
    const doelen = overgebleven === undefined ? rest : [overgebleven.anker];
    for (const doel of doelen) {
      if (doel !== groep.anker) {
        opdrachten.push({ naar: doel, bronnen: [groep.anker], gezaghebbend: groep.anker });
      }
    }
  }
  return opdrachten;
}

/** De cyclus en de vraag bij één stand van de bevestigingen. */
function cyclusVan(
  itemId: string,
  kandidaten: readonly CyclusKandidaat[],
  bevestigd: BevestigdeCycli | null
): Pick<BriefingTraining, 'cyclus' | 'cyclusKeuze'> {
  const { cyclus, keuze } = bepaalCyclusKeuze(itemId, kandidaten, bevestigd);
  return { cyclus, cyclusKeuze: keuze };
}
