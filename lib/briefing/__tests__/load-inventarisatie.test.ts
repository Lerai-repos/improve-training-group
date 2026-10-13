import { describe, expect, it } from 'vitest';

import { metInventarisatie } from '../load';

import type { BriefingTraining } from '../types';

// Test double: `metInventarisatie` leest alleen deze twee velden van de training.
const training = (opportunityItemId: string | null): BriefingTraining =>
  ({ opportunityItemId, inventarisatie: { kind: 'niet-gelezen' } }) as BriefingTraining;

describe('metInventarisatie', () => {
  it('zoekt de antwoorden op bij de Opportunity van de training', () => {
    const gevraagd: string[] = [];
    const uit = metInventarisatie(training('42'), (id) => {
      gevraagd.push(id);
      return { kind: 'ingevuld', op: 'nu', antwoorden: [] };
    });
    expect(gevraagd).toEqual(['42']);
    expect(uit.inventarisatie).toEqual({ kind: 'ingevuld', op: 'nu', antwoorden: [] });
  });

  /** Zonder Opportunity is er geen link; "nog niet ingevuld, de link staat op de Opportunity" klopt dan niet. */
  it('zegt het apart als er geen Opportunity is', () => {
    const uit = metInventarisatie(training(null), () => ({ kind: 'onleesbaar', fout: 'x' }));
    expect(uit.inventarisatie).toEqual({ kind: 'geen-opportunity' });
  });
});
