import { describe, expect, it, vi } from 'vitest';

import { runReport } from '../run';

import type { EvaluationResponse, TrainingRef } from '@lib/evaluations';
import type { LabelRecord } from '@lib/labels/read';
import type { ReportRunDeps } from '../run';
import type { TrainingForReport } from '../training';

const label: LabelRecord = {
  code: 'IT',
  volledigeNaam: 'Incompany Trainer',
  kleur: '#0A2B58',
  term: 'Training',
  rapportterm: 'de training',
  evaluatieformulier: '',
  website: '',
  inventarisatieformulier: '',
  logo: null,
  voorblad: null,
  achterblad: null,
};

const training: TrainingForReport = {
  itemId: 'i1',
  klanttitel: 'Onderhandelen',
  contactPersoon: 'Lisa',
  trainerNamen: ['Jan Bakker'],
  labelCode: 'IT',
  rawIeCode: '251050',
  rawLabel: 'IT',
  ieStatus: '',
};

const response = (rawCode: string): EvaluationResponse => ({
  source: { documentId: 'csv:test', sheetName: 'x', label: 'nl' },
  rowNumber: 2,
  rawCode,
  grade: 8,
  receivedAtRaw: null,
  answers: {
    program: 4,
    practical: 4,
    tools: 4,
    trainerExpertise: 5,
    trainerCommunication: 5,
    followUp: 'Ja',
    positive: 'Top',
    improvement: null,
  },
});

const ref = (id: string, code: string, klant: string, thema: string): TrainingRef => ({
  trainingItemId: id,
  rawIeCode: code,
  clientKey: klant,
  themaKey: thema,
});

const deps = (over: Partial<ReportRunDeps> = {}): ReportRunDeps => ({
  readTraining: async () => training,
  readLabel: async () => label,
  readResponses: async () => [response('251050')],
  readTrainings: async () => [ref('i1', '251050', 'WE Fashion', 'Onderhandelen')],
  renderer: { render: async () => new Uint8Array([1, 2, 3]) },
  ...over,
});

describe('runReport', () => {
  it('levert een PDF op bij een normale training', async () => {
    const outcome = await runReport('i1', deps());
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') {
      return;
    }
    expect(outcome.report.responseCount).toBe(1);
    expect(outcome.report.pdf).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('meldt een onbekend item', async () => {
    const outcome = await runReport('i9', deps({ readTraining: async () => null }));
    expect(outcome).toEqual({ kind: 'not_found', itemId: 'i9' });
  });

  /** Raden zou een document in de huisstijl van een ander merk opleveren. */
  it('weigert een label zonder configuratie, en rendert niets', async () => {
    const render = vi.fn(async () => new Uint8Array());
    const outcome = await runReport(
      'i1',
      deps({
        readTraining: async () => ({ ...training, labelCode: null, rawLabel: 'TMT' }),
        renderer: { render },
      })
    );
    expect(outcome.kind).toBe('unknown_label');
    expect(render).not.toHaveBeenCalled();
  });

  it('weigert ook als het label wel bekend is maar niet op het bord staat', async () => {
    const outcome = await runReport('i1', deps({ readLabel: async () => null }));
    expect(outcome.kind).toBe('unknown_label');
  });

  /**
   * "Geen code" is iets anders dan "geen reacties": bij het eerste is er nooit een evaluatie
   * uitgezet, bij het tweede wel en heeft niemand hem ingevuld. Dat vraagt om een ander
   * gesprek, en straks om een andere status in Monday.
   */
  it('onderscheidt een training zonder code van een training zonder reacties', async () => {
    const zonderCode = await runReport(
      'i1',
      deps({ readTraining: async () => ({ ...training, rawIeCode: null }) })
    );
    expect(zonderCode.kind).toBe('no_code');

    const zonderReacties = await runReport('i1', deps({ readResponses: async () => [] }));
    expect(zonderReacties.kind).toBe('no_responses');
  });

  /**
   * De introzin luidt "onze trainer **X** heeft ... gefaciliteerd". Zonder naam staat daar
   * een leeg vet vak in een document dat naar een klant gaat. Gemeten raakt weigeren 2
   * trainingen over twee jaargangen.
   */
  it('weigert een training zonder gekoppelde trainer, en rendert niets', async () => {
    const render = vi.fn(async () => new Uint8Array());
    const outcome = await runReport(
      'i1',
      deps({
        readTraining: async () => ({ ...training, trainerNamen: [] }),
        renderer: { render },
      })
    );
    expect(outcome.kind).toBe('missing_trainer');
    expect(render).not.toHaveBeenCalled();
  });

  it('leest de sheets niet als de training al is afgewezen', async () => {
    const readResponses = vi.fn(async () => []);
    await runReport('i1', deps({ readTraining: async () => null, readResponses }));
    expect(readResponses).not.toHaveBeenCalled();
  });

  /**
   * DE reden dat de toekenning over het hele bord gaat. Twee trainingen delen een code;
   * verschillende klant, dus het is een botsing en niet één sessie. Zou de selectie op de
   * code alleen gebeuren, dan stonden de reacties van Ander Bedrijf in dit rapport.
   *
   * De uitkomst is `ambiguous_code` en NIET `no_responses`: de reacties bestaan, ze zijn
   * alleen niet eenduidig toe te wijzen. Dat onderscheid bepaalt wat ITG moet doen — de
   * dubbele code herstellen, niet achter deelnemers aan.
   */
  it('meldt een botsende code van een andere klant als ambiguous_code', async () => {
    const outcome = await runReport(
      'i1',
      deps({
        readTrainings: async () => [
          ref('i1', '251050', 'WE Fashion', 'Onderhandelen'),
          ref('i2', '251050', 'Ander Bedrijf', 'Feedback'),
        ],
      })
    );
    expect(outcome.kind).toBe('ambiguous_code');
  });

  /** Dezelfde code, dezelfde klant én hetzelfde thema: één sessie, meerdere agendaregels. */
  it('deelt de reacties wel bij een bewust gedeelde code', async () => {
    const outcome = await runReport(
      'i1',
      deps({
        readTrainings: async () => [
          ref('i1', '251050', 'WE Fashion', 'Onderhandelen'),
          ref('i2', '251050', 'WE Fashion', 'Onderhandelen'),
        ],
      })
    );
    expect(outcome.kind).toBe('ok');
  });

  it('haalt responses en agenda parallel op', async () => {
    const order: string[] = [];
    await runReport(
      'i1',
      deps({
        readResponses: async () => {
          order.push('start-responses');
          await Promise.resolve();
          order.push('eind-responses');
          return [response('251050')];
        },
        readTrainings: async () => {
          order.push('start-agenda');
          return [ref('i1', '251050', 'WE Fashion', 'Onderhandelen')];
        },
      })
    );
    // De agenda begint vóórdat de responses klaar zijn; serieel zou dit omgekeerd staan.
    expect(order.indexOf('start-agenda')).toBeLessThan(order.indexOf('eind-responses'));
  });
});
