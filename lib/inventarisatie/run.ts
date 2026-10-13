import { gewensteLink } from './link';

import type { LabelCode } from '@lib/labels';
import type { OpportunityLabel } from './link';

/**
 * De link naar het inventarisatieformulier op elke Opportunity zetten, en houden.
 *
 * Eén regel voor drie aanroepers: de webhook (een nieuwe Opportunity of een ander label), de
 * nachtelijke ronde en het eenmalige script voor de bestaande Opportunities. Hij schrijft alleen
 * als er iets anders staat dan er hoort, dus opnieuw draaien is onschuldig. Dat vangt ook een
 * gedupliceerde Opportunity op (ITG dupliceert via Make.com): die neemt de link van het origineel
 * mee, met diens referentie.
 */

export interface OpportunityStand extends OpportunityLabel {
  /** De URL die er nu in de linkkolom staat; leeg als er niets staat. */
  readonly link: string;
  /** De zichtbare tekst van die link; hoort gelijk te zijn aan de URL, zie `linkWaarde`. */
  readonly tekst: string;
}

export interface InventarisatieDeps {
  readonly dryRun: boolean;
  /** De website per label, van het Labels-bord. */
  websites(): Promise<ReadonlyMap<LabelCode, string>>;
  leesOpportunity(itemId: string): Promise<OpportunityStand | null>;
  leesAlle(): Promise<readonly OpportunityStand[]>;
  /** `null` maakt de cel leeg. */
  schrijf(itemId: string, link: string | null): Promise<void>;
}

export type LinkUitkomst = 'geschreven' | 'gewist' | 'ongewijzigd' | 'niet-gevonden';

async function zet(
  deps: InventarisatieDeps,
  stand: OpportunityStand,
  websites: ReadonlyMap<LabelCode, string>
): Promise<LinkUitkomst> {
  const gewenst = gewensteLink(stand, websites);
  /**
   * Ook de tekst, niet alleen de URL: staat er "klik hier", dan is de link niet meer uit de cel
   * te kopiëren, en daar is de cel voor. Zonder link telt alleen dat de URL leeg is.
   */
  const klopt =
    gewenst === null
      ? stand.link.trim() === ''
      : stand.link.trim() === gewenst && stand.tekst.trim() === gewenst;
  if (klopt) {
    return 'ongewijzigd';
  }
  if (!deps.dryRun) {
    await deps.schrijf(stand.itemId, gewenst);
  }
  return gewenst === null ? 'gewist' : 'geschreven';
}

/** Eén Opportunity, vers gelezen: de webhook draagt een stand die al achterhaald kan zijn. */
export async function syncLink(deps: InventarisatieDeps, itemId: string): Promise<LinkUitkomst> {
  const [stand, websites] = await Promise.all([deps.leesOpportunity(itemId), deps.websites()]);
  return stand === null ? 'niet-gevonden' : zet(deps, stand, websites);
}

export interface LinkRapport {
  readonly dryRun: boolean;
  readonly opportunities: number;
  readonly geschreven: number;
  readonly gewist: number;
  readonly ongewijzigd: number;
  readonly mislukt: readonly { readonly itemId: string; readonly fout: string }[];
}

/**
 * Het hele bord. Een mislukte schrijfactie stopt de rest niet: die Opportunity komt in het
 * rapport, en de volgende nacht probeert het opnieuw.
 */
export async function syncAlleLinks(deps: InventarisatieDeps): Promise<LinkRapport> {
  const [standen, websites] = await Promise.all([deps.leesAlle(), deps.websites()]);
  const telling = { geschreven: 0, gewist: 0, ongewijzigd: 0, 'niet-gevonden': 0 };
  const mislukt: Array<{ itemId: string; fout: string }> = [];
  for (const stand of standen) {
    try {
      telling[await zet(deps, stand, websites)] += 1;
    } catch (error) {
      mislukt.push({
        itemId: stand.itemId,
        fout: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    dryRun: deps.dryRun,
    opportunities: standen.length,
    geschreven: telling.geschreven,
    gewist: telling.gewist,
    ongewijzigd: telling.ongewijzigd,
    mislukt,
  };
}
