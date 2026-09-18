/**
 * Waar de antwoorden van een trainingscyclus staan, en hoe ze daar komen.
 *
 * De antwoorden hangen aan het ANKER: de eerste sessie van de cyclus die nog te schrijven is.
 * Dat anker verschuift, en niet alleen als iemand iets bevestigt — bij de jaarwisseling
 * archiveert ITG een jaargang en schuift het vanzelf op. Dan wijst het naar een leeg record
 * terwijl het werk van de adviseur onder een andere sessie staat.
 *
 * Twee wegen daarheen, en ze vullen elkaar aan:
 *
 * 1. **Openstaande verhuizingen.** Wie een indeling wijzigt legt in hetzelfde record vast welke
 *    antwoorden mee moeten. Dat hoort bij de stand die de schrijfactie wint, dus niet bij een
 *    poging die het verloor, en het blijft staan tot het gedaan is — een hapering halverwege
 *    wordt dus door de volgende lezing afgemaakt.
 * 2. **Zoeken binnen de cyclus.** Verschuift het anker zonder dat er iets bevestigd is, dan is
 *    er niemand die een verhuizing had kunnen vastleggen. Dan wordt bij het lezen gekeken of
 *    een andere sessie van de cyclus de antwoorden draagt.
 *
 * Kopiëren is nooit verplaatsen en gebeurt alleen naar een LEEG formulier. Herhalen kan dus geen
 * kwaad, en niemands werk wordt ooit overschreven.
 */

import { ankerItemId } from './cyclus';
import { zonderVerhuizingen, type CyclusStore, type Verhuizing } from './cyclus-bevestiging';

import type { ChecklistStore, Fence } from './checklist-store';
import type { BriefingCyclus } from './types';

/**
 * Wat er van één verhuizing terechtkwam.
 *
 * `onleesbaar` is het geval dat níét stil mag blijven: er stáán antwoorden, maar ze zijn niet te
 * lezen. Ze als leeg behandelen zou de cyclus een schoon formulier geven en precies de grendel
 * omzeilen die voorkomt dat iemand onzichtbaar werk overschrijft.
 *
 * `opnieuw` is een schrijfactie die het hek of het token tegenhield: er is niets gekopieerd, en
 * de opdracht moet blijven staan. Hem als "niets te doen" wegstrepen zou werk kwijtmaken dat nog
 * verhuisd moest worden.
 */
type VerhuisUitkomst = 'gedaan' | 'niets-te-doen' | 'onleesbaar' | 'opnieuw';

/**
 * Eén verhuizing uitvoeren.
 *
 * Staat er al iets onder `naar`, dan blijft dat staan — behalve als de gezaghebbende bron
 * antwoorden heeft: dan is wat er onder `naar` staat een restant van vóór de cyclus, en winnen
 * de gedeelde antwoorden. Zonder gezaghebbende bron wordt er nooit iets overschreven.
 */
async function verhuis(
  checklists: ChecklistStore,
  opdracht: Verhuizing,
  fence: Fence
): Promise<VerhuisUitkomst> {
  const doel = await checklists.read(opdracht.naar);
  if (doel.unreadable) {
    return 'onleesbaar';
  }
  if (doel.saved !== null) {
    if (opdracht.gezaghebbend === undefined || opdracht.gezaghebbend === opdracht.naar) {
      return 'niets-te-doen';
    }
    const gezag = await checklists.read(opdracht.gezaghebbend);
    if (gezag.unreadable) {
      return 'onleesbaar';
    }
    if (gezag.saved === null) {
      return 'niets-te-doen';
    }
    const uit = await checklists.save(opdracht.naar, { ...gezag.saved, token: doel.token }, fence);
    return uit.kind === 'ok' ? 'gedaan' : 'opnieuw';
  }
  for (const itemId of new Set([opdracht.gezaghebbend ?? '', ...opdracht.bronnen])) {
    if (itemId === '' || itemId === opdracht.naar) {
      continue;
    }
    const bron = await checklists.read(itemId);
    if (bron.unreadable) {
      return 'onleesbaar';
    }
    if (bron.saved !== null) {
      const uit = await checklists.save(opdracht.naar, { ...bron.saved, token: doel.token }, fence);
      return uit.kind === 'ok' ? 'gedaan' : 'opnieuw';
    }
  }
  return 'niets-te-doen';
}

/**
 * De records van de andere sessies van de cyclus opruimen, zodra het anker de antwoorden heeft.
 *
 * Eén cyclus, één levend record. Een lid dat zelf nog een record draagt — van vóór het meedeed,
 * of van een schrijfactie die net te laat kwam — leest niemand meer, maar het kan later wél weer
 * voor "de antwoorden" doorgaan zodra het anker verschuift. Vandaar een grafsteen, met dezelfde
 * tokencontrole als elke schrijfactie: schrijft iemand er nú, dan wint die en kijkt de volgende
 * lezing opnieuw. Onleesbare records blijven staan; daar gaat de grendel over.
 */
async function ruimLedenOp(
  checklists: ChecklistStore,
  leden: readonly string[],
  anker: string,
  fence: Fence
): Promise<boolean> {
  const doel = await checklists.read(anker);
  if (doel.saved === null) {
    return true;
  }
  for (const itemId of leden) {
    if (itemId === anker) {
      continue;
    }
    const lid = await checklists.read(itemId);
    if (lid.saved !== null) {
      /**
       * Gehekt op de cyclusstand waar `leden` uit komt. Een lezing die even stil hing terwijl
       * een collega de cyclus veranderde en de antwoorden naar dít lid verhuisde, zou anders
       * precies het nieuwe anker wegvegen. Houdt het hek het tegen, dan is dat geen fout, maar
       * wel een teken dat deze lezing niet meer bij de huidige stand hoort.
       */
      if ((await checklists.clear(itemId, lid.token, fence)) === 'conflict') {
        return false;
      }
    }
  }
  return true;
}

/**
 * De openstaande verhuizingen van deze opdracht uitvoeren en uit het record halen.
 *
 * Iedereen die langskomt doet dit: het scherm, de knop en het bevestigen. Zo maakt de volgende
 * lezing af wat een vorige niet afkreeg, en is er geen moment waarop de indeling al gewijzigd is
 * terwijl niemand meer weet waar de antwoorden stonden.
 *
 * Een verhuizing waarvan de bron (of het doel) niet te lezen is blijft staan en komt terug in
 * `geblokkeerd`: de aanroeper toont díé cyclus als vergrendeld, net zoals bij onleesbare
 * antwoorden op de sessie zelf. Wegstrepen zou een lege checklist opleveren terwijl er ergens
 * antwoorden staan die niemand meer ziet.
 *
 * **Per sessie en niet per opdracht**: onder één Opportunity kunnen meerdere cycli staan, en een
 * probleem bij de ene mag de andere niet op slot zetten.
 */
export async function voerVerhuizingenUit(
  cycli: CyclusStore,
  checklists: ChecklistStore,
  opportunityItemId: string
): Promise<{ geblokkeerd: readonly string[]; opnieuw: boolean }> {
  const { stand, fence } = await cycli.readMetFence(opportunityItemId);
  const openstaand = stand?.verhuizingen ?? [];
  if (openstaand.length === 0) {
    return { geblokkeerd: [], opnieuw: false };
  }
  const gedaan: Verhuizing[] = [];
  const geblokkeerd: string[] = [];
  let opnieuw = false;
  /**
   * Op volgorde, en wat van een onopgeloste opdracht afhangt wacht.
   *
   * De opdrachten kunnen een keten vormen: na `A → B` kan een latere herindeling `B → D`
   * vastleggen. Zou de tweede doorgaan terwijl de eerste nog openstaat, dan vindt hij B leeg,
   * ziet "niets te doen" en wordt weggestreept — en zodra A weer leesbaar is landen de
   * antwoorden op B, terwijl het anker intussen D is.
   *
   * Maar niet álles wacht: onder één opdracht kunnen twee cycli staan, en een onleesbaar record
   * bij de ene mag de verhuizing van de andere niet ophouden. Een opdracht wacht alleen als hij
   * een item raakt dat in een eerdere onopgeloste opdracht voorkomt; wat wacht telt als
   * geblokkeerd, zodat zijn cyclus op slot gaat in plaats van een leeg formulier te tonen.
   */
  const besmet = new Set<string>();
  const raakt = (opdracht: Verhuizing): boolean =>
    besmet.has(opdracht.naar) ||
    opdracht.bronnen.some((id) => besmet.has(id)) ||
    (opdracht.gezaghebbend !== undefined && besmet.has(opdracht.gezaghebbend));
  const blokkeer = (opdracht: Verhuizing): void => {
    for (const id of [opdracht.naar, ...opdracht.bronnen, opdracht.gezaghebbend ?? '']) {
      if (id !== '') {
        besmet.add(id);
        geblokkeerd.push(id);
      }
    }
  };
  for (const opdracht of openstaand) {
    if (raakt(opdracht)) {
      blokkeer(opdracht);
      continue;
    }
    const uitkomst = await verhuis(checklists, opdracht, fence);
    if (uitkomst === 'onleesbaar') {
      blokkeer(opdracht);
      continue;
    }
    /**
     * Tegengehouden door hek of token: het record is intussen veranderd, dus élke volgende
     * schrijfactie met dit hek strandt ook. Hier stoppen; de aanroeper leest opnieuw en de rest
     * blijft staan.
     */
    if (uitkomst === 'opnieuw') {
      opnieuw = true;
      break;
    }
    gedaan.push(opdracht);
  }
  /**
   * Pas wegstrepen wat gedaan is. Gaat er hierboven iets mis, dan blijft het staan en probeert
   * de volgende lezing het opnieuw.
   */
  if (gedaan.length > 0) {
    await cycli.update(opportunityItemId, (huidig) =>
      huidig === null
        ? { groepen: [], beslist: {}, verhuizingen: [] }
        : zonderVerhuizingen(huidig, gedaan)
    );
  }
  return { geblokkeerd, opnieuw };
}

/**
 * Het anker van deze training, opgeruimd.
 *
 * Eén aanroep voor elke weg naar de checklist — het scherm, de knop en het bevestigen — zodat
 * ze niet van elkaar kunnen verschillen over waar de antwoorden horen te staan. Het anker komt
 * uit het record; hier wordt alleen gezorgd dat het het enige levende record van de cyclus is.
 *
 * `geblokkeerd`: het anker zelf is niet te lezen. `opnieuw`: een opruimactie werd door het hek
 * tegengehouden, de cyclus verschoof dus net; de aanroeper leest opnieuw.
 */
export async function ankerMetAntwoorden(
  checklists: ChecklistStore,
  training: { readonly itemId: string; readonly cyclus: BriefingCyclus | null },
  /** Het hek van het cyclusrecord waar `training.cyclus` uit is afgeleid. */
  fence: Fence
): Promise<{ readonly anker: string; readonly geblokkeerd: boolean; readonly opnieuw: boolean }> {
  const anker = ankerItemId(training);
  const sessies = training.cyclus?.sessies ?? [];
  if (sessies.length < 2) {
    return { anker, geblokkeerd: false, opnieuw: false };
  }
  const doel = await checklists.read(anker);
  if (doel.unreadable) {
    return { anker, geblokkeerd: true, opnieuw: false };
  }
  const opgeruimd = await ruimLedenOp(
    checklists,
    sessies.map((sessie) => sessie.itemId),
    anker,
    fence
  );
  return { anker, geblokkeerd: false, opnieuw: !opgeruimd };
}

/**
 * Gaat een geblokkeerde verhuizing over DEZE training?
 *
 * Onder één opdracht kunnen meerdere cycli staan. Een onleesbaar record bij de ene cyclus zegt
 * niets over de andere, en zou die anders zonder reden op slot zetten.
 */
export function raaktDezeCyclus(
  geblokkeerd: readonly string[],
  training: { readonly itemId: string; readonly cyclus: BriefingCyclus | null }
): boolean {
  const eigen = new Set([
    training.itemId,
    ...(training.cyclus?.sessies ?? []).map((sessie) => sessie.itemId),
  ]);
  return geblokkeerd.some((itemId) => eigen.has(itemId));
}
