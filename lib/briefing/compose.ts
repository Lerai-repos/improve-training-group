/**
 * Van `BriefingTraining` naar de velden die het sjabloon invult.
 *
 * Dit is de enige plek waar de gegevenstabel wordt samengesteld. De lezer haalt op wat er
 * in Monday staat, `format.ts` bepaalt hoe één waarde eruitziet, en hier komt het bij
 * elkaar in de vorm die `docx-templates` verwacht.
 *
 * ## Wat er nog niet is aangesloten
 *
 * Verschillende secties komen niet uit het agendabord en zijn nog niet gebouwd of nog
 * geblokkeerd: de achtergrondinformatie, de concept-bullets, het inventarisatieformulier, de
 * historie bij dezelfde klant, de reisafstand en de trainingscode MC. Die zijn hier
 * **invoer**, geen aanname.
 *
 * Ontbreekt zo'n stuk, dan komt er een `«…»`-regel in het document te staan die zegt wát er
 * mist en waar het vandaan moet komen. Bewust zichtbaar en bewust lelijk: een briefing met
 * een lege achtergrondsectie ziet eruit als een afgeronde briefing, en die zou zo naar een
 * trainer kunnen. Deze niet.
 *
 * `undefined` en `[]` zijn daarom niet hetzelfde en mogen nooit worden samengenomen:
 * `undefined` is "wij hebben deze bron nog niet", `[]` is "gecontroleerd, er is niets". De
 * eerste hoort zichtbaar te zijn, de tweede hoort te zwijgen.
 */

import { formatAccountmanager, formatContact } from './columns';
import { formatDeadline, materialsDeadline } from './deadline';
import {
  formatDateTime,
  formatDuration,
  formatEvaluation,
  formatGroupSize,
  formatIeCode,
  formatClientContact,
  formatTravel,
  formatLanguage,
  MATERIALS_SUFFIX,
  type TravelInput,
} from './format';
import {
  selectBlocks,
  type BriefingBlock,
  type BriefingChecklist,
  type HistoryRow,
  type SessionFacts,
} from './blocks';
import { isOpenIssue, notConnected, notDecided } from './open-issues';
import { resolveConceptInhoud } from './concept';

import type { BriefingTrainer, BriefingTraining } from './types';

/** Eén vraag en antwoord uit het inventarisatieformulier. */
export interface InventoryAnswer {
  readonly vraag: string;
  readonly antwoord: string;
}

/**
 * Alles wat niet uit het agendabord komt.
 *
 * Elk veld is optioneel omdat elke bron een eigen opleverdatum heeft. `undefined` betekent
 * "nog niet aangesloten" en levert een zichtbare `«…»`-regel op; een lege array betekent
 * "aangesloten en er is niets", en dat is een geldig antwoord dat gewoon niets afdrukt.
 */
export interface BriefingExtras {
  /** Uit het Briefings-board; de adviseur schrijft deze zelf. */
  readonly achtergrond?: readonly string[];
  /** Uit de Monday-updates met het voorvoegsel `voor in briefing:`. */
  readonly extraInfo?: readonly string[];
  /**
   * De concept-inhoud, als de aanroeper hem al heeft samengesteld.
   *
   * Normaal blijft dit leeg en komt hij uit het thema plus de checklist — zie
   * `resolveConceptInhoud`. Dit is de ontsnapping voor een aanroeper die hem elders al
   * heeft uitgerekend.
   */
  readonly bullets?: readonly string[];
  /** Uit het Google Form van het label. */
  readonly inventarisatie?: readonly InventoryAnswer[];
  /** Eerdere en komende sessies bij dezelfde klant, voor het blok `Vaste klant`. */
  readonly historie?: readonly HistoryRow[];
  /** Km en reistijd van de toegewezen trainer. */
  readonly reis?: TravelInput;
  /** `IT-58`. Nog niet uitgezocht of deze afleidbaar is uit label en thema. */
  readonly trainingscodeMc?: string;
  /** Zet de harde regel onder de achtergrondinformatie. */
  readonly mondayChallenge?: boolean;
  /**
   * De rolverdeling, als de aanroeper die al heeft uitgerekend — bijvoorbeeld omdat de
   * adviseur zelf heeft aangewezen wie de acteur is. Zonder dit wordt hij hier bepaald uit
   * Monday en de checklist.
   */
  readonly roles?: SessionFacts;
}

/** Precies de velden die de negen sjablonen aanroepen. */
export interface BriefingDocumentData {
  readonly opdrachtgever: string;
  readonly thema: string;
  readonly klanttitel: string;
  readonly duur: string;
  readonly datumTijd: string;
  readonly groepsgrootte: string;
  readonly locatie: string;
  readonly voertaal: string;
  readonly materialenDeadline: string;
  readonly accountmanager: string;
  readonly reis: string;
  readonly contactpersoon: string;
  readonly klantcontactmoment: string;
  readonly evaluatie: string;
  readonly iecode: string;
  readonly trainingscodeMc: string;
  readonly achtergrond: readonly string[];
  readonly extraInfo: readonly string[];
  readonly mondayChallenge: boolean;
  readonly bullets: readonly string[];
  readonly blokken: readonly BriefingBlock[];
  readonly inventarisatie: readonly InventoryAnswer[];
}

const MISSING = {
  achtergrond: notDecided(
    'achtergrondinformatie (de aanleidingtekst)',
    'de kolom Achtergrondinformatie op de gekoppelde Opportunity is nog leeg'
  ),
  extraInfo: notConnected('extra informatie trainer', 'Monday-updates met "voor in briefing:"'),
  bullets: notConnected(
    'concept-inhoud',
    'de standaardbullets per thema in Monday (skelettenbestand van ITG), of de afwijkende ' +
      'versie die de AM er zelf in plakt'
  ),
  inventarisatie: notConnected('inventarisatie klant', 'Google Form van het label'),
  reis: notConnected('km en reistijd', 'route van de trainer naar de locatie'),
  trainingscodeMc: notConnected('trainingscode MC', 'nog niet belegd, zie 06-briefing.md'),
} as const;

/**
 * Zet de training om in de velden van het sjabloon.
 *
 * Werpt niet bij ontbrekende gegevens. Wat verplicht is en leeg staat al in
 * `training.missing`, en de aanroeper beslist wat daarmee gebeurt: `Brie` op "Begonnen,
 * niet klaar" zetten en tóch genereren is een geldige uitkomst, want de adviseur ziet dan
 * in het document zelf welke rij leeg is.
 */
export function composeBriefing(
  training: BriefingTraining,
  checklist: BriefingChecklist,
  extras: BriefingExtras = {}
): BriefingDocumentData {
  const deadline = formatDeadline(materialsDeadline({ datum: training.datum, tijden: training.tijden }));

  return {
    opdrachtgever: training.opdrachtgever.trim(),
    thema: training.themas.join(' & '),
    klanttitel: training.klanttitel.trim(),
    duur: formatDuration(training.duur),
    datumTijd: formatDateTime(training.datum, training.tijden),
    groepsgrootte: formatGroupSize(training.groepsgrootte),
    locatie: training.locatie.trim(),
    voertaal: formatLanguage(training.voertaal),
    materialenDeadline: deadline === '' ? '' : `${deadline} ${MATERIALS_SUFFIX}`,
    accountmanager:
      training.accountmanager === null
        ? ''
        : formatAccountmanager(training.accountmanager.naam, training.accountmanager.mobiel),
    reis: extras.reis === undefined ? MISSING.reis : formatTravel(extras.reis),
    contactpersoon:
      training.contactpersoon === null
        ? ''
        : formatContact(training.contactpersoon.naam, training.contactpersoon.telefoon),
    klantcontactmoment: formatClientContact(training.klantcontactmoment),
    evaluatie: formatEvaluation(training.evaluatie),
    iecode: formatIeCode(training.ieCode),
    trainingscodeMc: extras.trainingscodeMc ?? MISSING.trainingscodeMc,
    achtergrond: achtergrondAlineas(training, extras),
    extraInfo: extras.extraInfo ?? [MISSING.extraInfo],
    mondayChallenge: extras.mondayChallenge ?? false,
    bullets:
      extras.bullets ??
      resolveConceptInhoud({
        themaTekst: training.themaInhoud,
        adviseurTekst: checklist.conceptInhoud,
        organisatie: training.opdrachtgever,
      }) ?? [MISSING.bullets],
    blokken: selectBlocks(checklist, extras.historie, extras.roles ?? sessionFacts(training, checklist)),
    inventarisatie:
      extras.inventarisatie ?? [{ vraag: MISSING.inventarisatie, antwoord: '' }],
  };
}

/**
 * De achtergrondinformatie als alinea's.
 *
 * Komt uit `itg_achtergrond` op de Opportunity — Dirkje: *"Denk dan in het opportunitybord een
 * lang tekstveld. We gebruiken wel altijd meerdere alinea's."* `extras.achtergrond` blijft
 * bestaan zodat een aanroeper hem kan overschrijven, maar de bron is nu de kolom.
 *
 * Een lege kolom is **geen ontbrekende bron** meer maar een leeg veld: de kolom bestaat, de
 * adviseur heeft hem nog niet ingevuld. Dat hoort in `training.missing` thuis, niet in een
 * `«…»`-regel. Wel blijft er iets zichtbaars in het document staan, want een lege sectie ziet
 * eruit als een afgeronde briefing.
 */
function achtergrondAlineas(training: BriefingTraining, extras: BriefingExtras): readonly string[] {
  if (extras.achtergrond !== undefined) {
    return extras.achtergrond;
  }
  const alineas = training.achtergrond
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => r !== '');
  return alineas.length > 0 ? alineas : [MISSING.achtergrond];
}

/** De gekoppelde personen die in de groep `Acteurs` staan; voor de voorinvulling. */
export function countLinkedActors(training: BriefingTraining): number {
  return training.trainers.filter((t) => t.isActeur).length;
}

/** Wie de adviseur zelf als acteur heeft aangewezen, per item-id op het trainersbord. */
export interface RoleOverrides {
  readonly actorItemIds?: readonly string[];
}

/**
 * De gekoppelde personen ingedeeld naar rol, met de onbeslisbare gevallen apart.
 *
 * **De checklist wint van Monday.** Zegt de adviseur dat er geen acteur meewerkt, dan is
 * iedereen trainer — ook iemand die in de groep `Acteurs` staat. Die groep zegt wat iemand
 * meestal doet, niet welke rol hij in déze sessie heeft, en het is de adviseur die de sessie
 * kent. Zonder deze voorrang zou `--geen-acteur` een gekoppelde trainer alsnog uit de
 * ontvangers en uit de bestandsnaam laten vallen, precies tegen het antwoord in dat net
 * gegeven is.
 *
 * Zegt de adviseur wél dat er een acteur is, dan wijzen twee bronnen er een aan, en pas samen
 * zijn ze compleet genoeg: de groep `Acteurs` op het trainersbord, en wat de adviseur zelf
 * opgeeft. Blijft er daarna een acteur over die `Acteuraantal` wél belooft maar die nergens
 * is aan te wijzen, dan is van álle overgebleven personen de rol onbeslist — niet van een
 * specifieke.
 */
function classify(
  training: BriefingTraining,
  checklist: BriefingChecklist,
  overrides: RoleOverrides
): { actors: BriefingTrainer[]; others: BriefingTrainer[]; unaccounted: number } {
  if (!checklist.trainingActor) {
    return { actors: [], others: [...training.trainers], unaccounted: 0 };
  }
  const aangewezen = new Set(overrides.actorItemIds ?? []);
  const actors = training.trainers.filter((t) => t.isActeur || aangewezen.has(t.itemId));
  const others = training.trainers.filter((t) => !actors.includes(t));
  const expected = Math.max(training.acteuraantal ?? 1, 1);
  return {
    actors,
    others,
    unaccounted: Math.min(Math.max(0, expected - actors.length), others.length),
  };
}

/**
 * De rolverdeling als **aantallen**, voor de blokkeuze.
 *
 * Drie hoeveelheden en niet twee, omdat "niet in de groep Acteurs" niet hetzelfde is als
 * "zeker trainer". Belooft `Acteuraantal` meer acteurs dan er aan te wijzen zijn, dan is van
 * die personen de rol onbekend — gemeten 8 keer bij precies twee gekoppelden. Die als trainer
 * tellen levert het co-trainerblok op dat deze hele scheiding moest voorkomen.
 *
 * De checklist beslist óf er een acteur is; `Acteuraantal` zegt alleen hoevéél het er dan
 * zijn. Zegt de adviseur nee, dan is er niets onbekends: iedereen is trainer.
 */
export function sessionFacts(
  training: BriefingTraining,
  checklist: BriefingChecklist,
  overrides: RoleOverrides = {}
): SessionFacts {
  const { actors, others, unaccounted } = classify(training, checklist, overrides);
  return {
    certainTrainers: others.length - unaccounted,
    identifiedActors: actors.length,
    unknownRole: unaccounted,
  };
}

/**
 * Wie de briefing ontvangt, of het antwoord dat dat niet vaststaat.
 *
 * Dit is bewust géén lijst met een vraagteken erbij. De ontvangers bepalen de bestandsnaam en
 * straks bij wie het document terechtkomt, en dat zijn **identiteiten**, geen aantallen.
 * Weten dat één van twee mensen de trainer is, is genoeg om te weten dát er één trainer is,
 * en niet genoeg om zijn naam op het bestand te zetten.
 *
 * Precies dat gebeurde: `Acteuraantal=1` met twee gekoppelde personen die geen van beiden in
 * de groep `Acteurs` staan — 8 keer gemeten — leverde een bestandsnaam op met de acteur
 * erin. `ambiguous` dwingt de aanroeper om eerst te vragen wie wie is.
 */
export type Recipients =
  | { readonly kind: 'resolved'; readonly trainers: readonly BriefingTrainer[] }
  | {
      readonly kind: 'ambiguous';
      /** Iedereen die trainer óf acteur kan zijn; welke van de twee staat nergens. */
      readonly candidates: readonly BriefingTrainer[];
      /** Hoeveel van die kandidaten volgens `Acteuraantal` acteur zijn. */
      readonly actorsUnaccounted: number;
    };

export function resolveRecipients(
  training: BriefingTraining,
  checklist: BriefingChecklist,
  overrides: RoleOverrides = {}
): Recipients {
  const { others, unaccounted } = classify(training, checklist, overrides);
  if (unaccounted > 0) {
    return { kind: 'ambiguous', candidates: others, actorsUnaccounted: unaccounted };
  }
  return { kind: 'resolved', trainers: others };
}

/**
 * Elke openstaande regel in het samengestelde document, zodat een aanroeper kan besluiten
 * om niet te leveren. Zo hoeft niemand het document zelf af te speuren.
 *
 * Kijkt óók in de blokken en in de gegevenstabel, want daar zitten de twee soorten die het
 * makkelijkst over het hoofd te zien zijn: de historie die nog niet is aangesloten, en een
 * QR-kolom die op `0. NOTK` staat.
 */
export function openIssues(data: BriefingDocumentData): string[] {
  const texts = [
    data.reis,
    data.trainingscodeMc,
    data.evaluatie,
    ...data.achtergrond,
    ...data.extraInfo,
    ...data.bullets,
    ...data.blokken.flatMap((blok) => blok.regels),
    ...data.inventarisatie.flatMap((v) => [v.vraag, v.antwoord]),
  ];
  return texts.filter(isOpenIssue);
}
