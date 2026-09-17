import { OPPORTUNITY_COLUMNS } from './columns';

import type { BriefingTraining } from './types';

/**
 * De achtergrondinformatie zoals de adviseur hem in de tab heeft achtergelaten.
 *
 * Dirkje, 17-Sep-2026: de tekst staat op de Opportunity, maar trainingen worden naar de agenda
 * gekopieerd zonder dat iemand hem aanvult. Daarom een tekstvak in de tab, net als de
 * concept-inhoud: voorgevuld met de Opportunity, en pas opgeslagen als er echt getypt is.
 *
 * `undefined` betekent "gebruik de Opportunity", zodat een tekst die daar later verschijnt deze
 * training nog bereikt. Staat er wel eigen tekst, dan vervangt die de Opportunity overal: in
 * het document, in de checklist en in de melding "Begonnen, niet klaar". Eén functie, zodat
 * het scherm en het genereren niet elk een eigen idee hebben over wat er leeg is.
 */
export function metEigenAchtergrond(
  training: BriefingTraining,
  eigen: string | undefined
): BriefingTraining {
  if (eigen === undefined) {
    return training;
  }
  const kolom = OPPORTUNITY_COLUMNS.achtergrond;
  const zonder = training.missing.filter((veld) => veld.column !== kolom);
  return {
    ...training,
    achtergrond: eigen,
    missing:
      eigen.trim() === '' ? [...zonder, { column: kolom, label: 'Achtergrondinformatie' }] : zonder,
  };
}
