/**
 * Welke sessies samen één trainingscyclus zijn, en dus één briefing krijgen.
 *
 * Dirkje, 17-Sep-2026, over CNV: drie sessies in de toekomst, dezelfde trainer, één
 * Opportunity — *"die hoort eigenlijk allemaal bij één opportunity, dus bij één opdracht"* — en
 * toch staan ze als losse trainingen in elkaars historietabel. ITG legt nergens vast dat sessies
 * bij elkaar horen, dus dit wordt afgeleid.
 *
 * **Maar afgeleid is niet besloten.** Tim, 18-Sep-2026: de tab laat de gevonden sessies zien met
 * vinkjes en vraagt of ze samen één briefing krijgen. Tot iemand dat bevestigt verandert er
 * niets en houdt elke sessie haar eigen briefing. De regel hieronder zet de vinkjes alleen
 * voor; het antwoord van de adviseur wint altijd.
 *
 * **De regel** (Dirkje akkoord via WhatsApp, Tim 17-Sep-2026): dezelfde Opportunity,
 * `DuurcategorieAG` op trainingscyclus, dezelfde klanttitel (op een volgnummer aan het eind
 * na), dezelfde thema's en precies dezelfde lead- en co-trainers. Een sessie zonder trainer
 * wordt nooit voorgesteld.
 *
 * **Een sessie zonder thema doet mee.** Gemeten op Agenda 2026: van de vier cycli die op het
 * thema uiteenvielen was er bij drie één sessie waar niemand het thema had ingevuld (NWO,
 * Reinaerde, Chrono Welluswijs); alleen Erasmus had echt andere thema's.
 */

import { groepVan, type BevestigdeCycli } from './cyclus-bevestiging';
import type { BriefingCyclus, BriefingSessie, CyclusKeuze, CyclusOptie } from './types';

/** Eén agenda-item onder dezelfde Opportunity, zoals de cyclusregel het bekijkt. */
export interface CyclusKandidaat {
  readonly itemId: string;
  readonly boardId: string;
  readonly gearchiveerd: boolean;
  /** `DuurcategorieAG` staat op trainingscyclus. */
  readonly isCyclus: boolean;
  readonly klanttitel: string;
  readonly themaIds: readonly string[];
  readonly leadIds: readonly string[];
  readonly coIds: readonly string[];
  /** De namen van lead- en co-trainers, voor het scherm. */
  readonly trainerNamen: string;
  readonly datum: string;
  readonly tijden: string;
  readonly locatie: string;
  readonly groepsgrootte: string;
  /** De kolom `Duur` als tekst; het cyclusdocument telt de sessies hieruit op. */
  readonly duur: string;
  readonly ieCode: string;
}

/**
 * De klanttitel zonder volgnummer aan het eind.
 *
 * ITG nummert de sessies van een cyclus soms in de titel: International School Almere heeft
 * `Navigating difficult conversations I` en `… II` (Tim, 17-Sep-2026: dat is één cyclus). Een
 * écht andere titel blijft verschillen, zoals Reinaerde's `Kennismaken team` en `Intervisie`
 * onder dezelfde Opportunity.
 */
const titelSleutel = (titel: string): string =>
  titel
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/ (?:[ivx]+|\d+)$/, '');

const setSleutel = (ids: readonly string[]): string => [...new Set(ids)].sort().join(',');

const trainerSleutel = (k: CyclusKandidaat): string =>
  `${setSleutel(k.leadIds)}|${setSleutel(k.coIds)}`;

const heeftTrainer = (k: CyclusKandidaat): boolean => k.leadIds.length + k.coIds.length > 0;

/** Zonder datum achteraan, en bij gelijke datum op item-id zodat de volgorde vastligt. */
const opDatum = (a: CyclusKandidaat, b: CyclusKandidaat): number => {
  if ((a.datum === '') !== (b.datum === '')) {
    return a.datum === '' ? 1 : -1;
  }
  return a.datum.localeCompare(b.datum) || a.itemId.localeCompare(b.itemId);
};

const alsSessie = (k: CyclusKandidaat): BriefingSessie => ({
  itemId: k.itemId,
  boardId: k.boardId,
  gearchiveerd: k.gearchiveerd,
  datum: k.datum,
  tijden: k.tijden,
  locatie: k.locatie,
  groepsgrootte: k.groepsgrootte,
  duur: k.duur,
  ieCode: k.ieCode,
  zonderThema: k.themaIds.length === 0,
});

/** Wat de regel van de andere sessies vindt: wie hij voorstelt, en waarom niet. */
interface Voorstel {
  readonly leden: ReadonlySet<string>;
  readonly redenen: ReadonlyMap<string, string>;
}

/**
 * Het voorstel van de regel: welke andere sessies waarschijnlijk bij deze training horen.
 *
 * Zet alleen de vinkjes voor. Een sessie die er volgens de regel niet bij hoort krijgt een
 * reden, zodat de adviseur kan zien waarom hij hem zelf zou moeten aanvinken.
 */
export function regelVoorstel(itemId: string, kandidaten: readonly CyclusKandidaat[]): Voorstel {
  const huidig = kandidaten.find((k) => k.itemId === itemId);
  if (huidig === undefined) {
    throw new Error(
      `Briefing: training ${itemId} kwam niet terug bij het zoeken naar haar eigen cyclus. ` +
        'Dan is de koppeling met de Opportunity niet te vertrouwen.'
    );
  }
  const redenen = new Map<string, string>();
  if (!huidig.isCyclus || !heeftTrainer(huidig)) {
    return { leden: new Set([itemId]), redenen };
  }

  const anderen = kandidaten.filter((k) => k.itemId !== itemId && k.isCyclus);
  const titel = titelSleutel(huidig.klanttitel);
  const trainers = trainerSleutel(huidig);

  /** Klanttitel en trainers eerst; de thema's zijn pas over die groep te beoordelen. */
  const redenZonderThema = (k: CyclusKandidaat): string | null => {
    if (titelSleutel(k.klanttitel) !== titel) {
      return `een andere klanttitel ("${k.klanttitel.trim()}")`;
    }
    if (!heeftTrainer(k)) {
      return 'geen trainer';
    }
    return trainerSleutel(k) === trainers ? null : 'andere trainers';
  };
  const basis = [huidig, ...anderen.filter((k) => redenZonderThema(k) === null)];
  const themasets = new Set(
    basis.filter((k) => k.themaIds.length > 0).map((k) => setSleutel(k.themaIds))
  );
  const legeDoenMee = themasets.size <= 1;
  const eigenThema = huidig.themaIds.length === 0 ? null : setSleutel(huidig.themaIds);

  const hoortErbij = (k: CyclusKandidaat): boolean => {
    if (k.themaIds.length === 0) {
      return eigenThema === null || legeDoenMee;
    }
    return eigenThema === null ? legeDoenMee : setSleutel(k.themaIds) === eigenThema;
  };

  const leden = new Set(basis.filter(hoortErbij).map((k) => k.itemId));
  for (const k of anderen) {
    if (leden.has(k.itemId)) {
      continue;
    }
    redenen.set(
      k.itemId,
      redenZonderThema(k) ??
        (k.themaIds.length === 0
          ? "geen thema, en de cyclus heeft verschillende thema's"
          : "andere thema's")
    );
  }
  return { leden, redenen };
}

/**
 * De cyclus van deze training plus de vraag die de tab stelt.
 *
 * `cyclus` is wat er in het document komt en is **alleen wat er bevestigd is**: zonder
 * bevestiging krijgt deze sessie haar eigen briefing, precies zoals voorheen. `keuze` is de
 * lijst met vinkjes, of `null` als er niets te vragen valt.
 */
export function bepaalCyclusKeuze(
  itemId: string,
  kandidaten: readonly CyclusKandidaat[],
  bevestigd: BevestigdeCycli | null
): { readonly cyclus: BriefingCyclus | null; readonly keuze: CyclusKeuze | null } {
  const voorstel = regelVoorstel(itemId, kandidaten);
  /**
   * Een lege rij op het agendabord is geen sessie om te vragen.
   *
   * Onder een Opportunity hangt soms een item zonder datum en zonder trainer — gemeten bij
   * Reinaerde. Zo'n rij kan nooit een briefing worden, en als vraag op het scherm is ze alleen
   * een lege regel met een vinkje ervoor.
   */
  const anderen = kandidaten
    .filter((k) => k.itemId !== itemId && !(k.datum === '' && !heeftTrainer(k)))
    .sort(opDatum);
  if (anderen.length === 0) {
    return { cyclus: null, keuze: null };
  }

  const groep = groepVan(bevestigd, itemId);
  /** Waartegen de indeling van DEZE sessie beslist is; `undefined` betekent: nooit gevraagd. */
  const gezien = bevestigd?.beslist[itemId];
  const isBeslist = gezien !== undefined;
  /**
   * Beantwoord zonder groep is een antwoord, en wel "nee": dan staan de vinkjes uit in plaats
   * van weer op het voorstel van de regel. Anders zou de tab het "nee" van gisteren elke keer
   * overschrijven met wat wij denken.
   */
  const inCyclus = (id: string): boolean => {
    if (groep !== null) {
      return groep.leden.includes(id);
    }
    if (isBeslist) {
      return id === itemId;
    }
    return id === itemId || voorstel.leden.has(id);
  };

  /** Op datum, deze training ertussen: zo leest de lijst als de volgorde van de cyclus zelf. */
  const opties: CyclusOptie[] = [...kandidaten.filter((k) => k.itemId === itemId), ...anderen]
    .sort(opDatum)
    .map((k) =>
      k.itemId === itemId
        ? optie(k, true, true, true)
        : optie(
            k,
            false,
            inCyclus(k.itemId),
            voorstel.leden.has(k.itemId),
            voorstel.redenen.get(k.itemId)
          )
    );

  const leden = kandidaten
    .filter((k) => k.itemId === itemId || anderen.includes(k))
    .filter((k) => inCyclus(k.itemId))
    .sort(opDatum);
  return {
    /** Eén sessie is geen cyclus: dan is er niets te bundelen, ook niet als het bevestigd is. */
    cyclus:
      groep !== null && leden.length > 1
        ? { sessies: leden.map(alsSessie), anker: groep.anker }
        : null,
    keuze: {
      opties,
      /** Nog niet beantwoord voor minstens één sessie: dan staat de vraag nog open. */
      /**
       * Open zolang deze sessie nooit beoordeeld is, of zolang er een sessie bij is gekomen
       * sinds dat gebeurde. Wat een ánder item beslist heeft telt hier niet mee: dat ging over
       * zijn indeling, niet over deze.
       */
      openstaand: !isBeslist || anderen.some((k) => !(gezien ?? []).includes(k.itemId)),
    },
  };
}

function optie(
  k: CyclusKandidaat,
  huidig: boolean,
  aangevinkt: boolean,
  voorgesteld: boolean,
  reden?: string
): CyclusOptie {
  return {
    itemId: k.itemId,
    datum: k.datum,
    klanttitel: k.klanttitel,
    trainers: k.trainerNamen,
    huidig,
    aangevinkt,
    voorgesteld,
    reden: reden ?? null,
  };
}

/**
 * De training zoals het BESTAND heet: bij een cyclus altijd met de datum van de eerste sessie.
 *
 * Dit is de identiteit van het document, en die moet vastliggen. Zou elke sessie op haar eigen
 * datum schrijven, dan botsen de bestanden niet met elkaar en staat er na de jaarwisseling — als
 * het anker verschuift omdat de oude jaargang archiveert — een tweede briefing in de klantmap
 * voor dezelfde cyclus. Nu schrijft elke sessie naar dezelfde naam, en ziet de adviseur netjes
 * de botsing met wat er al ligt.
 *
 * Bewust de EERSTE sessie en niet de eerste schrijfbare: een archivering mag de naam van een
 * bestaand document niet veranderen.
 */
export function cyclusIdentiteit<
  T extends { readonly datum: string; readonly cyclus: BriefingCyclus | null },
>(training: T): T {
  const eerste = training.cyclus?.sessies[0];
  if (eerste === undefined || eerste.datum === '') {
    return training;
  }
  return { ...training, datum: eerste.datum };
}

/**
 * Waar de antwoorden van een groep komen te staan als die gevormd of veranderd wordt: de eerste
 * sessie die te schrijven is.
 *
 * **Alleen bij het toewijzen.** Waar ze daarna stáán zegt het record (`Groep.anker`); dit
 * herberekenen om het te weten ging mis zodra het verschoof. Nooit een sessie op een gearchiveerd
 * bord: de checklist-route weigert die, en dan mislukt elke wijziging in de tab.
 */
export function schrijfbaarAnker(
  leden: readonly string[],
  kandidaten: readonly CyclusKandidaat[]
): string | null {
  const sessies = kandidaten.filter((k) => leden.includes(k.itemId)).sort(opDatum);
  if (sessies.length === 0) {
    return null;
  }
  return (sessies.find((k) => !k.gearchiveerd) ?? sessies[0]).itemId;
}

/**
 * Onder welk item de antwoorden van de tab staan: het vastgelegde anker van de bevestigde cyclus,
 * of de training zelf. Eén plek, zodat lezen en schrijven hetzelfde anker gebruiken.
 */
export function ankerItemId(training: {
  readonly itemId: string;
  readonly cyclus: BriefingCyclus | null;
}): string {
  return training.cyclus?.anker ?? training.itemId;
}
