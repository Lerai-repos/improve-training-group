import { loadAgendaBoards } from '@lib/evaluations';

import { bepaalCyclusKeuze, schrijfbaarAnker, type CyclusKandidaat } from './cyclus';
import { voerVerhuizingenUit } from './cyclus-antwoorden';
import { readCyclusKandidaten } from './cyclus-read';
import { readBriefingTraining, type BriefingRelations } from './read';

import {
  cyclusStoreKey,
  groepVan,
  metAnker,
  metVerhuizingen,
  type BevestigdeCycli,
  type CyclusStore,
} from './cyclus-bevestiging';
import type { ChecklistStore, Fence } from './checklist-store';
import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { BriefingTraining } from './types';

/**
 * Eén training, mét de trainingscyclus waar ze bij hoort.
 *
 * De tab en de knop lezen allebei hierdoor, zodat ze dezelfde cyclus zien: de antwoorden hangen
 * aan de eerste sessie, en een scherm dat een ander anker kiest dan de server schrijft onder
 * het ene en genereert uit het andere.
 *
 * `cyclus` is alleen wat er BEVESTIGD is; `cyclusKeuze` is de vraag met de vinkjes. Zonder
 * bevestiging verandert er dus niets aan de briefing.
 */
export interface GeladenBriefing {
  readonly training: BriefingTraining;
  /**
   * Het hek van het cyclusrecord waar `training.cyclus` uit komt. Elke schrijfactie op de
   * checklist die daarvan afhangt geeft dit mee, zodat ze niet doorgaat als de cyclus intussen
   * is veranderd.
   */
  readonly fence: Fence;
  /** Sessies waarvan een verhuizing vastloopt op onleesbare antwoorden; zie `raaktDezeCyclus`. */
  readonly geblokkeerd: readonly string[];
}

export async function readBriefingMetCyclus(
  client: MondayGraphQLClient,
  itemId: string,
  options: {
    readonly boardId: string;
    readonly relations: BriefingRelations;
    readonly cycli: CyclusStore;
    readonly checklists: ChecklistStore;
  }
): Promise<GeladenBriefing> {
  const [training, borden] = await Promise.all([
    readBriefingTraining(client, itemId, options),
    loadAgendaBoards(client),
  ]);
  const zonder = (fence: Fence, geblokkeerd: readonly string[]): GeladenBriefing => ({
    training: { ...training, cyclus: null, cyclusKeuze: null },
    fence,
    geblokkeerd,
  });
  if (training.opportunityItemId === null) {
    return zonder({ key: cyclusStoreKey(''), token: 'absent' }, []);
  }

  /**
   * Eérst afmaken wat er nog openstond, dán het record lezen.
   *
   * Een verhuizing die klaar is wordt uit het record gehaald, en dat verandert de versie waar
   * het hek op staat. Zou het record vóór die stap gelezen zijn, dan is elk hek dat hieruit
   * volgt al verouderd, wordt elke herstelschrijfactie tegengehouden, en toont de tab een leeg
   * formulier terwijl de antwoorden onder een andere sessie staan.
   */
  const { geblokkeerd } = await voerVerhuizingenUitMetHerkansing(
    options.cycli,
    options.checklists,
    training.opportunityItemId
  );
  const { stand: bevestigd, fence } = await options.cycli.readMetFence(training.opportunityItemId);

  if (!moetZoeken(itemId, training.opdrachten.trainingCycle, bevestigd)) {
    return zonder(fence, geblokkeerd);
  }

  const kandidaten = await readCyclusKandidaten(
    client,
    training.opportunityItemId,
    borden.boards
  );
  if (kandidaten.length === 0) {
    return zonder(fence, geblokkeerd);
  }

  /**
   * De jaarwisseling: het vastgelegde anker staat op een bord dat intussen gearchiveerd is.
   *
   * Daar valt niet meer te schrijven, dus het anker verhuist naar de eerste sessie die dat nog
   * wél kan — als een gewone, vastgelegde verhuizing met het oude anker als gezaghebbende bron.
   * Niet afgeleid bij het lezen, want dan wist niemand meer waar de antwoorden stonden zodra een
   * lid nog een restant van vóór de cyclus droeg.
   */
  const verschoven = await verplaatsVerlopenAnker(options, training.opportunityItemId, itemId, kandidaten);
  const stand = verschoven ?? { stand: bevestigd, fence, geblokkeerd };
  const { cyclus, keuze } = bepaalCyclusKeuze(itemId, kandidaten, stand.stand);
  return {
    training: { ...training, cyclus, cyclusKeuze: keuze },
    fence: stand.fence,
    geblokkeerd: stand.geblokkeerd,
  };
}

/**
 * Als het anker van de groep van `itemId` niet meer te beschrijven is: verplaats het en voer de
 * verhuizing uit. Geeft de nieuwe stand terug, of `null` als er niets te doen was.
 */
async function verplaatsVerlopenAnker(
  options: { readonly cycli: CyclusStore; readonly checklists: ChecklistStore },
  opportunityItemId: string,
  itemId: string,
  kandidaten: readonly CyclusKandidaat[]
): Promise<{ stand: BevestigdeCycli | null; fence: Fence; geblokkeerd: readonly string[] } | null> {
  const huidig = await options.cycli.read(opportunityItemId);
  const groep = groepVan(huidig, itemId);
  if (groep === null) {
    return null;
  }
  const anker = kandidaten.find((k) => k.itemId === groep.anker);
  if (anker !== undefined && !anker.gearchiveerd) {
    return null;
  }
  const nieuw = schrijfbaarAnker(groep.leden, kandidaten);
  if (nieuw === null || nieuw === groep.anker) {
    return null;
  }
  await options.cycli.update(opportunityItemId, (stand) => {
    if (stand === null || groepVan(stand, itemId)?.anker !== groep.anker) {
      /** Intussen al door een ander gedaan, of de groep bestaat niet meer: niets aanraken. */
      return stand ?? { groepen: [], beslist: {}, verhuizingen: [] };
    }
    return metVerhuizingen(metAnker(stand, groep.leden, nieuw), [
      { naar: nieuw, bronnen: [groep.anker], gezaghebbend: groep.anker },
    ]);
  });
  const { geblokkeerd } = await voerVerhuizingenUitMetHerkansing(
    options.cycli,
    options.checklists,
    opportunityItemId
  );
  const { stand, fence } = await options.cycli.readMetFence(opportunityItemId);
  return { stand, fence, geblokkeerd };
}

/**
 * Valt er iets te bundelen? Zoeken kost een query per agendabord, dus niet bij elke training.
 *
 * Twee redenen om wél te zoeken. De training draagt het cycluslabel — dan hoort de vraag
 * gesteld te worden. Óf er is over déze sessie al eens iets bevestigd: het label kan namelijk
 * verdwijnen (iemand zet `DuurcategorieAG` om) en een sessie zonder label kan bewust bij een
 * cyclus zijn gevinkt. Zonder die tweede reden ziet zo'n sessie zichzelf als losse training,
 * mét een eigen lege checklist, terwijl de andere sessies haar nog bij de cyclus rekenen.
 */
export function moetZoeken(
  itemId: string,
  heeftCycluslabel: boolean,
  bevestigd: BevestigdeCycli | null
): boolean {
  if (heeftCycluslabel) {
    return true;
  }
  return (
    bevestigd !== null &&
    (bevestigd.beslist[itemId] !== undefined ||
      bevestigd.groepen.some((groep) => groep.leden.includes(itemId)))
  );
}

/** Twee adviseurs die tegelijk iets doen: even overdoen is genoeg. Blijft het botsen, dan werpt dit. */
const MAX_HERKANSINGEN = 3;

/**
 * Een kopie die door hek of token werd tegengehouden is een tijdelijke botsing, geen toestand
 * om te tonen: dan is er niets verhuisd en zou de tab een leeg of verouderd formulier laten
 * zien. Dus opnieuw, met een verse stand. Lukt het ook dan niet, dan is het beter om te
 * weigeren dan te gokken; de tab toont een fout met "Opnieuw proberen".
 */
export class CyclusDruk extends Error {
  constructor() {
    super(
      'De antwoorden van deze trainingscyclus worden op dit moment verplaatst door een collega; ' +
        'laad de tab opnieuw.'
    );
    this.name = 'CyclusDruk';
  }
}

async function voerVerhuizingenUitMetHerkansing(
  cycli: CyclusStore,
  checklists: ChecklistStore,
  opportunityItemId: string
): Promise<{ geblokkeerd: readonly string[] }> {
  for (let poging = 0; poging < MAX_HERKANSINGEN; poging += 1) {
    const uit = await voerVerhuizingenUit(cycli, checklists, opportunityItemId);
    if (!uit.opnieuw) {
      return { geblokkeerd: uit.geblokkeerd };
    }
  }
  throw new CyclusDruk();
}
