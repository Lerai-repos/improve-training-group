import { attributeResponses } from '@lib/evaluations';
import { generateReport } from './generate';

import type { EvaluationResponse, TrainingRef } from '@lib/evaluations';
import type { LabelCode } from '@lib/labels';
import type { LabelRecord } from '@lib/labels/read';
import type { GeneratedReport, PdfRenderer } from './generate';
import type { TrainingForReport } from './training';

/**
 * De hele keten voor één training: agenda → label → responses → PDF.
 *
 * Alles is ingespoten, zodat dit getest kan worden zonder Monday, Google of Chromium — en
 * zodat de route en het script dezélfde volgorde en dezelfde weigeringen gebruiken. Een
 * handmatige herdraai die net iets anders beslist dan de dagjob is precies het soort
 * verschil waar niemand achter komt.
 */

export interface ReportRunDeps {
  readTraining: (itemId: string) => Promise<TrainingForReport | null>;
  readLabel: (code: LabelCode) => Promise<LabelRecord | null>;
  /** ALLE responses; welke documenten dat zijn is adapterconfiguratie, geen keuze van hier. */
  readResponses: () => Promise<readonly EvaluationResponse[]>;
  /** Elke training op de agenda — nodig om een gedeelde code van een botsing te onderscheiden. */
  readTrainings: () => Promise<readonly TrainingRef[]>;
  renderer: PdfRenderer;
}

export type ReportRunOutcome =
  | {
      readonly kind: 'ok';
      readonly training: TrainingForReport;
      readonly label: LabelRecord;
      readonly report: GeneratedReport;
    }
  | { readonly kind: 'not_found'; readonly itemId: string }
  /** Het label op de agenda heeft geen rij op het Labels-bord. Nooit raden. */
  | { readonly kind: 'unknown_label'; readonly training: TrainingForReport }
  /** De training heeft geen IE-code, dus er valt niets toe te kennen. */
  | { readonly kind: 'no_code'; readonly training: TrainingForReport }
  /** Wel een code, geen reacties: de 'geen data'-situatie. */
  | { readonly kind: 'no_responses'; readonly training: TrainingForReport }
  /**
   * Geen trainer gekoppeld.
   *
   * De introzin luidt "onze trainer **X** heeft ... gefaciliteerd"; zonder naam staat daar
   * een leeg vet element midden in een brief aan een klant. Monday staat deze toestand toe,
   * dus hij moet hier worden opgevangen — gemeten raakt dat 2 trainingen over twee
   * jaargangen (308 van de 309 trainingen mét code hebben ook een trainer), dus weigeren
   * kost vrijwel niets en voorkomt een document dat er verzorgd uitziet en niet klopt.
   */
  | { readonly kind: 'missing_trainer'; readonly training: TrainingForReport }
  /**
   * Meerdere klanten claimen deze code, dus de toekenning houdt de reacties tegen.
   *
   * Er ZIJN reacties. Dit als "geen reacties" melden zou de verkeerde reparatie in gang
   * zetten — ITG moet de dubbele code herstellen, niet achter deelnemers aan.
   */
  | { readonly kind: 'ambiguous_code'; readonly training: TrainingForReport };

export async function runReport(itemId: string, deps: ReportRunDeps): Promise<ReportRunOutcome> {
  const training = await deps.readTraining(itemId);
  if (training === null) {
    return { kind: 'not_found', itemId };
  }
  if (training.labelCode === null) {
    return { kind: 'unknown_label', training };
  }
  if (training.trainerNamen.length === 0) {
    return { kind: 'missing_trainer', training };
  }
  if (training.rawIeCode === null) {
    /**
     * Onderscheiden van "geen reacties".
     *
     * Zonder code is er niets misgegaan met de evaluatie — er is er nooit een uitgezet. Dat
     * vraagt om een ander gesprek dan een sessie waar wél een code hing en niemand hem
     * invulde, en de statuskolom in Monday hoort dat verschil straks ook te tonen.
     */
    return { kind: 'no_code', training };
  }

  const label = await deps.readLabel(training.labelCode);
  if (label === null) {
    return { kind: 'unknown_label', training };
  }

  /**
   * Responses en agenda PARALLEL: ze hangen niet van elkaar af en dit zijn de twee trage
   * stappen — drie Google-documenten naast twee agendaborden.
   */
  const [responses, trainings] = await Promise.all([deps.readResponses(), deps.readTrainings()]);

  /**
   * Toekennen over het HELE bord, niet alleen deze training.
   *
   * ITG hergebruikt een code soms bewust en tikt hem soms per ongeluk dubbel — 13 tegen 14
   * in het echte corpus. Alleen naar deze training kijken kan die twee niet uit elkaar
   * houden, en dan staan de reacties van de ene klant in het rapport van de andere.
   */
  const attribution = attributeResponses(responses, trainings);

  /**
   * Eerst kijken of de code wél eenduidig is.
   *
   * `attributeResponses` houdt de reacties bij een botsing bewust tegen, dus `mine` is dan
   * leeg terwijl er reacties bestaan — en `generateReport` zou daar `no_responses` van maken.
   */
  if (attribution.report.trainingsWithAmbiguousCode.includes(itemId)) {
    return { kind: 'ambiguous_code', training };
  }

  const mine = attribution.responsesByTraining.get(itemId) ?? [];

  const outcome = await generateReport({ training, label, responses: mine }, deps.renderer);
  if (outcome.kind === 'no_responses') {
    return { kind: 'no_responses', training };
  }
  return { kind: 'ok', training, label, report: outcome.report };
}
