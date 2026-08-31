import { composeBriefing, openIssues, sessionFacts } from './compose';
import { resolveRecipientRoles, type Recipient } from './recipients';
import { briefingFilename, renderBriefing } from './render';

import type { BriefingChecklist, HistoryRow } from './blocks';
import type { TravelInput } from './format';
import type { BriefingTraining } from './types';

/**
 * Eén training naar één document per ontvanger.
 *
 * Puur ten opzichte van Monday en SharePoint: alles wat gelezen moet worden komt hier als
 * argument binnen. Dat is wat het mogelijk maakt om precies dit — de stap waar het echte
 * werk zit — te draaien zonder tenant, en het is dezelfde keten die
 * `scripts/briefing-generate.ts` al gebruikte om de documenten naast ITG's eigen voorbeeld
 * te leggen.
 */

/**
 * De bestandsnaam voor één ontvanger, en met opzet de ENIGE plek waar hij ontstaat.
 *
 * Het plannen en het schrijven moeten exact dezelfde naam uitrekenen. Doen ze dat niet, dan
 * zoekt de botsingscontrole naar een bestand dat nooit geschreven wordt: er komt geen
 * bevestiging, en er verschijnt stilletjes een `(v2)` die niemand heeft goedgekeurd.
 *
 * Dat was hier bijna misgegaan. `composeBriefing` zet `thema` op `themas.join(' & ')`, niet
 * op `klanttitel` — twee velden die op de meeste trainingen op hetzelfde neerkomen en op de
 * rest niet. Vandaar één functie in plaats van twee plekken die het "hetzelfde" doen.
 */
function filenameFor(training: BriefingTraining, trainerNaam: string): string {
  return briefingFilename({
    opdrachtgever: training.opdrachtgever.trim(),
    thema: training.themas.join(' & '),
    isoDatum: training.datum,
    // Eén naam: dit exemplaar is van deze persoon, ook als het een acteur is.
    trainers: [trainerNaam],
  });
}

export interface GenerateContext {
  /** Eerdere en komende sessies bij dezelfde klant, voor het blok `Vaste klant`. */
  readonly historie: readonly HistoryRow[];
  /** De gemarkeerde updates van het agenda-item en de Opportunity. */
  readonly extraInfo: readonly string[];
  /** Km en reistijd per trainer-itemId. */
  readonly reis: ReadonlyMap<string, TravelInput>;
  /** Door de adviseur aangewezen acteurs. */
  readonly actorItemIds: readonly string[];
}

export interface GeneratedDocument {
  readonly trainerItemId: string;
  readonly trainerNaam: string;
  readonly role: Recipient['role'];
  readonly filename: string;
  readonly bytes: Uint8Array;
  /**
   * Bronnen die in dit document als zichtbare `«…»`-regel landen.
   *
   * Per ontvanger, want ze verschillen: alleen de leadtrainer krijgt het klantcontactmoment,
   * dus een ontbrekende contactpersoon raakt zijn document wél en dat van de acteur niet.
   */
  readonly open: readonly string[];
}

export type GenerateResult =
  | { readonly kind: 'ok'; readonly documents: readonly GeneratedDocument[] }
  /** Er valt geen document te maken: geen lead, of een onoplosbare rolverdeling. */
  | { readonly kind: 'refused'; readonly reason: string };

export async function generateBriefings(
  training: BriefingTraining,
  checklist: BriefingChecklist,
  context: GenerateContext
): Promise<GenerateResult> {
  const rollen = resolveRecipientRoles(training, checklist, {
    actorItemIds: context.actorItemIds,
  });
  if (rollen.kind !== 'resolved') {
    /**
     * De tab weet dit al en toont het met de handeling erbij; hier is het een vangnet.
     * Zonder eenduidige lead is er niet één document dat klopt, dus er komt er géén — een
     * half document is erger dan geen document.
     */
    return {
      kind: 'refused',
      reason:
        rollen.kind === 'no_single_lead'
          ? 'Geen eenduidige leadtrainer op deze training.'
          : 'De rolverdeling is niet vast te stellen; wijs aan wie de acteur is.',
    };
  }

  const gedeeld = {
    historie: context.historie,
    extraInfo: context.extraInfo,
    roles: sessionFacts(training, checklist, { actorItemIds: context.actorItemIds }),
  };

  const documents: GeneratedDocument[] = [];
  for (const ontvanger of rollen.recipients) {
    const eigen = composeBriefing(training, checklist, {
      ...gedeeld,
      recipient: ontvanger,
      reis: context.reis.get(ontvanger.trainer.itemId),
    });
    documents.push({
      trainerItemId: ontvanger.trainer.itemId,
      trainerNaam: ontvanger.trainer.naam,
      role: ontvanger.role,
      filename: filenameFor(training, ontvanger.trainer.naam),
      bytes: await renderBriefing(training.label, eigen),
      open: openIssues(eigen),
    });
  }

  return { kind: 'ok', documents };
}

/**
 * De namen die dit zou opleveren, zonder iets te renderen.
 *
 * Het plannen heeft ze nodig om te kunnen zeggen wélke briefings er al liggen, en renderen
 * kost een sjabloon per ontvanger — te duur voor een vraag die alleen over namen gaat.
 */
export function plannedFilenames(
  training: BriefingTraining,
  checklist: BriefingChecklist,
  actorItemIds: readonly string[]
): readonly string[] {
  const rollen = resolveRecipientRoles(training, checklist, { actorItemIds });
  if (rollen.kind !== 'resolved') {
    return [];
  }
  return rollen.recipients.map((ontvanger) => filenameFor(training, ontvanger.trainer.naam));
}
