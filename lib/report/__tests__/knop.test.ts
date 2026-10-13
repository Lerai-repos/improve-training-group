import { describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '@lib/recommend/kv';
import { mailRecipients } from '@lib/mail';

import { createKnopProbleemStore } from '../knop-store';
import {
  EVAL_STATUS_COLUMN,
  EVAL_STATUS_INDEX,
  parseEvalKnopWebhook,
  runEvalKnop,
} from '../knop';
import { EVAL_COLUMNS, IE_STATUS_COLUMN, IE_STATUS_INDEX } from '../record';

import type { EvaluationResponse } from '@lib/evaluations';
import type { LabelRecord } from '@lib/labels/read';
import type { OutgoingMail } from '@lib/mail';
import type { DailyAgendaTraining, DailyMailDeps } from '../daily';
import type { EvalKnopDeps, EvalStatusWaarde } from '../knop';
import type { TrainingForReport } from '../training';

const BORD = '5087396949';

describe('parseEvalKnopWebhook', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    event: {
      type: 'update_column_value',
      boardId: 5087396949,
      pulseId: 2912597013,
      columnId: EVAL_STATUS_COLUMN,
      value: { label: { index: EVAL_STATUS_INDEX.run, text: 'RUN' } },
      triggerUuid: 'abc',
      ...over,
    },
  });

  it('beantwoordt de challenge', () => {
    expect(parseEvalKnopWebhook({ challenge: 'x' })).toEqual({ kind: 'challenge', challenge: 'x' });
  });

  it('start bij Eval Status → RUN', () => {
    expect(parseEvalKnopWebhook(event())).toEqual({
      kind: 'run',
      itemId: '2912597013',
      boardId: BORD,
      triggerUuid: 'abc',
    });
  });

  /** Op index en niet op tekst, zodat ITG het label mag hernoemen. */
  it('herkent RUN aan de index, ook als het label anders heet', () => {
    const hernoemd = event({ value: { label: { index: EVAL_STATUS_INDEX.run, text: 'Maak' } } });
    expect(parseEvalKnopWebhook(hernoemd).kind).toBe('run');
  });

  /** De lusbeveiliging: ons eigen leegmaken en `Geen IE-code` komen ook als webhook binnen. */
  it('negeert elke andere waarde van Eval Status', () => {
    const geenCode = event({ value: { label: { index: EVAL_STATUS_INDEX.geenIeCode } } });
    expect(parseEvalKnopWebhook(geenCode).kind).toBe('negeren');
    expect(parseEvalKnopWebhook(event({ value: null })).kind).toBe('negeren');
  });

  it('negeert een andere kolom', () => {
    expect(parseEvalKnopWebhook(event({ columnId: 'status23' })).kind).toBe('negeren');
  });

  it('negeert een event zonder item of bord', () => {
    expect(parseEvalKnopWebhook(event({ pulseId: undefined })).kind).toBe('negeren');
    expect(parseEvalKnopWebhook(event({ boardId: undefined })).kind).toBe('negeren');
  });

  it('negeert rommel', () => {
    expect(parseEvalKnopWebhook(null).kind).toBe('negeren');
    expect(parseEvalKnopWebhook({ event: 'x' }).kind).toBe('negeren');
  });

  it('accepteert een ontbrekende triggerUuid', () => {
    expect(parseEvalKnopWebhook(event({ triggerUuid: null }))).toMatchObject({
      kind: 'run',
      triggerUuid: null,
    });
  });
});

const label: LabelRecord = {
  code: 'IT',
  volledigeNaam: 'Incompany Trainer',
  kleur: '#0A2B58',
  term: 'Training',
  rapportterm: 'de training',
  evaluatieformulier: '',
  website: '',
  logo: null,
  voorblad: null,
  achterblad: null,
};

const training: TrainingForReport = {
  itemId: 'i1',
  klanttitel: 'RSV Breda',
  contactPersoon: 'Lisa',
  trainerNamen: ['Jan'],
  labelCode: 'IT',
  rawIeCode: '260814',
  rawLabel: 'IT',
  klant: '',
  ieStatusIndex: IE_STATUS_INDEX.onvindbaar,
  datum: '2026-09-17',
  themaNamen: ['Persoonlijke effectiviteit'],
  trainerItemIds: ['t1'],
  accountmanager: 'Dirkje',
};

const response: EvaluationResponse = {
  source: { documentId: 'x', sheetName: 'y', label: 'nl' },
  rowNumber: 2,
  rawCode: '260814',
  grade: 8,
  receivedAtRaw: null,
  answers: {
    program: 4,
    practical: 4,
    tools: 4,
    trainerExpertise: 5,
    trainerCommunication: 5,
    followUp: 'Ja',
    positive: null,
    improvement: null,
  },
};

const agendaItem = (
  id: string,
  over: Partial<DailyAgendaTraining['ref']> & { datum?: string } = {}
): DailyAgendaTraining => ({
  trainingItemId: id,
  datum: over.datum ?? '2026-09-17',
  boardId: BORD,
  live: true,
  ref: {
    trainingItemId: id,
    rawIeCode: '260814',
    clientKey: 'RSV',
    themaKey: 'PE',
    ...over,
  },
});

/** Alles wat de knop aanraakt, met een logboek van wat er gebeurde. */
function harness(over: Partial<EvalKnopDeps> = {}, mailOver: Partial<DailyMailDeps> = {}) {
  const log: string[] = [];
  const statussen: EvalStatusWaarde[] = [];
  const updates: string[] = [];
  const geschreven: Array<Record<string, unknown>> = [];
  const verstuurd: OutgoingMail[] = [];
  const alVerstuurd = new Set<string>();
  const problemen = createKnopProbleemStore(createMemoryKvStore());

  const mail: DailyMailDeps = {
    recipients: mailRecipients({}),
    sender: {
      send: async (m) => {
        verstuurd.push(m);
      },
    },
    guard: {
      // De dagjob zou hier stoppen; de knop mag dat nooit gebruiken.
      claim: async (itemId, variant) =>
        alVerstuurd.has(`${itemId}:${variant}`)
          ? { kind: 'bezet', reden: 'verstuurd' }
          : { kind: 'claimed', token: 't' },
      forceClaim: async () => ({ kind: 'claimed', token: 't' }),
      confirm: async () => 'ok',
      release: async () => 'ok',
    },
    failures: { record: async () => undefined, clear: async () => undefined, list: async () => [] },
    renderer: { render: async () => new Uint8Array([1]) },
    readTrainerEmails: async () => ['jan@voorbeeld.nl'],
    nowMs: () => 1,
    ...mailOver,
  };

  const deps: EvalKnopDeps = {
    readAgenda: async () => {
      log.push('agenda');
      return [agendaItem('i1')];
    },
    readTraining: async () => training,
    readLabels: async () => new Map([['IT', label]]),
    readResponses: async () => [response],
    writeColumns: async (_item, _bord, values) => {
      geschreven.push(values);
    },
    mail,
    setEvalStatus: async (_item, _bord, waarde) => {
      log.push(`status:${waarde}`);
      statussen.push(waarde);
    },
    postUpdate: async (_item, tekst) => {
      updates.push(tekst);
    },
    problemen,
    vandaag: () => '2026-10-12',
    nowMs: () => 5,
    ...over,
  };
  return { deps, log, statussen, updates, geschreven, verstuurd, alVerstuurd, problemen };
}

describe('runEvalKnop', () => {
  /** Zoals legacy: eerst leegmaken, zodat de knop opnieuw ingedrukt kan worden. */
  it('maakt Eval Status leeg vóór er iets gelezen wordt', async () => {
    const h = harness();
    await runEvalKnop(h.deps, 'i1', BORD);
    expect(h.log.slice(0, 2)).toEqual(['status:leeg', 'agenda']);
  });

  it('maakt het rapport, werkt het bord bij en stuurt de twee mails', async () => {
    const h = harness();
    const uitkomst = await runEvalKnop(h.deps, 'i1', BORD);

    expect(uitkomst.status).toBe('leeg');
    expect(h.geschreven).toEqual([
      {
        [EVAL_COLUMNS.respondenten]: 1,
        [EVAL_COLUMNS.eindcijfer]: 8,
        [IE_STATUS_COLUMN]: { index: IE_STATUS_INDEX.neutraal },
      },
    ]);
    expect(h.verstuurd).toHaveLength(2);
    expect(h.verstuurd.every((m) => m.attachment !== undefined)).toBe(true);
    expect(h.statussen).toEqual(['leeg']);
    expect(h.updates).toEqual([]);
  });

  /** Het hele verschil met de dagjob: de knop stuurt ook als het al eens gebeurd is. */
  it('stuurt opnieuw, ook als de mails al eerder verstuurd zijn', async () => {
    const h = harness();
    h.alVerstuurd.add('i1:met');
    await runEvalKnop(h.deps, 'i1', BORD);
    expect(h.verstuurd).toHaveLength(2);
  });

  it('wacht op een verzending die op dit moment loopt', async () => {
    const h = harness(
      {},
      {
        guard: {
          claim: async () => ({ kind: 'bezet', reden: 'bezig' }),
          forceClaim: async () => ({ kind: 'bezet', reden: 'bezig' }),
          confirm: async () => 'ok',
          release: async () => 'ok',
        },
      }
    );
    const uitkomst = await runEvalKnop(h.deps, 'i1', BORD);
    expect(h.verstuurd).toHaveLength(0);
    expect(uitkomst.line?.mailNote).toContain('bezig');
  });

  it('zet zonder reacties Onvindbaar en stuurt de twee ZONDER-mails', async () => {
    const h = harness({ readResponses: async () => [] });
    await runEvalKnop(h.deps, 'i1', BORD);
    expect(h.geschreven[0][IE_STATUS_COLUMN]).toEqual({ index: IE_STATUS_INDEX.onvindbaar });
    expect(h.verstuurd).toHaveLength(2);
    expect(h.verstuurd.every((m) => m.attachment === undefined)).toBe(true);
    expect(h.statussen).toEqual(['leeg']);
  });

  /** Zoals legacy: zonder code komt er `Geen IE-code` op Eval Status, verder niets. */
  it('zet zonder IE-code Geen IE-code en doet verder niets', async () => {
    const h = harness({ readTraining: async () => ({ ...training, rawIeCode: null }) });
    const uitkomst = await runEvalKnop(h.deps, 'i1', BORD);
    expect(h.statussen).toEqual(['leeg', 'geen-ie-code']);
    expect(uitkomst.status).toBe('geen-ie-code');
    expect(h.geschreven).toEqual([]);
    expect(h.verstuurd).toEqual([]);
    expect(await h.problemen.list()).toEqual([]);
  });

  describe('wanneer er geen rapport van kan komen', () => {
    it('noemt bij een dubbele code de andere training', async () => {
      const h = harness({
        readAgenda: async () => [
          agendaItem('i1', { clientKey: null }),
          agendaItem('i2', { clientKey: null, datum: '2026-08-28' }),
        ],
      });
      const uitkomst = await runEvalKnop(h.deps, 'i1', BORD);

      expect(uitkomst.status).toBe('zie-systeembord');
      expect(h.statussen).toEqual(['leeg', 'zie-systeembord']);
      expect(h.verstuurd).toEqual([]);
      expect(h.geschreven).toEqual([]);
      const [probleem] = await h.problemen.list();
      expect(probleem.reden).toContain('260814');
      expect(probleem.reden).toContain('i2');
      expect(probleem.reden).toContain('28-08-2026');
      expect(h.updates[0]).toContain(probleem.reden);
    });

    it('meldt een label zonder instellingen', async () => {
      const h = harness({ readTraining: async () => ({ ...training, rawLabel: 'Email', labelCode: null }) });
      await runEvalKnop(h.deps, 'i1', BORD);
      const [probleem] = await h.problemen.list();
      expect(probleem.reden).toContain('"Email"');
      expect(h.statussen.at(-1)).toBe('zie-systeembord');
    });

    it('meldt een training zonder trainer', async () => {
      const h = harness({ readTraining: async () => ({ ...training, trainerNamen: [] }) });
      await runEvalKnop(h.deps, 'i1', BORD);
      expect((await h.problemen.list())[0].reden).toContain('trainer');
    });

    /** Legacy sloeg een toekomstige datum over; zonder melding drukt iemand gewoon nog eens. */
    it('weigert een training die nog niet geweest is', async () => {
      const h = harness({ readTraining: async () => ({ ...training, datum: '2026-10-13' }) });
      await runEvalKnop(h.deps, 'i1', BORD);
      expect((await h.problemen.list())[0].reden).toContain('nog niet geweest');
      expect(h.verstuurd).toEqual([]);
    });

    it('meldt een training die niet op een actief agendabord staat', async () => {
      const h = harness({ readAgenda: async () => [] });
      await runEvalKnop(h.deps, 'i1', BORD);
      expect((await h.problemen.list())[0].reden).toContain('actief agendabord');
      expect(h.statussen.at(-1)).toBe('zie-systeembord');
    });

    /**
     * Een storing mag niet als stilte eindigen: Eval Status staat dan al leeg, dus zonder
     * melding lijkt het alsof de knop gewoon niets deed.
     */
    it('meldt een storing in plaats van te werpen', async () => {
      const h = harness({
        readResponses: async () => {
          throw new Error('Google Sheets 503');
        },
      });
      const uitkomst = await runEvalKnop(h.deps, 'i1', BORD);
      expect(uitkomst.status).toBe('zie-systeembord');
      expect((await h.problemen.list())[0].reden).toContain('Google Sheets 503');
      expect(h.updates).toHaveLength(1);
    });

    /**
     * Een mislukte mail heeft al zijn eigen melding (`mail-mislukt`), dus geen tweede op het
     * Systeem-bord; wel de status en de update, want daar kijkt degene die drukte.
     */
    it('meldt een mislukte mail op de training, zonder dubbele Systeem-bordmelding', async () => {
      const h = harness(
        {},
        {
          sender: {
            send: async () => {
              throw new Error('403 Forbidden');
            },
          },
        }
      );
      const uitkomst = await runEvalKnop(h.deps, 'i1', BORD);
      expect(uitkomst.status).toBe('zie-systeembord');
      expect(await h.problemen.list()).toEqual([]);
      expect(h.updates[0]).toContain('403');
    });

    /** Een update die niet lukt mag de echte reden niet overschrijven met zijn eigen fout. */
    it('bewaart de echte reden als de update op het item mislukt', async () => {
      const h = harness({
        readTraining: async () => ({ ...training, trainerNamen: [] }),
        postUpdate: async () => {
          throw new Error('update kapot');
        },
      });
      await expect(runEvalKnop(h.deps, 'i1', BORD)).rejects.toThrow('update kapot');
      const [probleem] = await h.problemen.list();
      expect(probleem.reden).toContain('trainer');
      expect(h.statussen.at(-1)).toBe('zie-systeembord');
    });

    /**
     * Het antwoord aan Monday is dan al weg; alleen KV en de update blijven over als spoor.
     * Een mislukte statusschrijving mag die twee niet meenemen.
     */
    it('legt het probleem vast, ook als Eval Status niet geschreven kan worden', async () => {
      const h = harness({
        readTraining: async () => ({ ...training, trainerNamen: [] }),
        setEvalStatus: async (_item, _bord, waarde) => {
          if (waarde === 'zie-systeembord') {
            throw new Error('Monday 503');
          }
        },
      });
      await expect(runEvalKnop(h.deps, 'i1', BORD)).rejects.toThrow('Monday 503');
      expect((await h.problemen.list())[0].reden).toContain('trainer');
      expect(h.updates).toHaveLength(1);
    });

    /**
     * Mislukt het leegmaken aan het begin, dan gaat de verwerking gewoon door — anders blijft
     * de training op RUN staan zonder dat er iets gebeurt. Aan het eind opnieuw proberen, want
     * op RUN laten betekent dat de volgende druk op de knop niets meer doet.
     */
    it('verwerkt door als het leegmaken aan het begin mislukt, en probeert het aan het eind opnieuw', async () => {
      let keer = 0;
      const statussen: EvalStatusWaarde[] = [];
      const h = harness({
        setEvalStatus: async (_item, _bord, waarde) => {
          keer += 1;
          if (keer === 1) {
            throw new Error('Monday 503');
          }
          statussen.push(waarde);
        },
      });
      const uitkomst = await runEvalKnop(h.deps, 'i1', BORD);
      expect(h.verstuurd).toHaveLength(2);
      expect(uitkomst.status).toBe('leeg');
      expect(statussen).toEqual(['leeg']);
    });

    /**
     * Een eerdere knopdruk liet een reden achter; deze druk loste die op maar struikelde bij
     * het mailen. `mail-mislukt` meldt het nieuwe probleem, dus het oude moet weg — anders
     * staan er twee meldingen waarvan er één niet meer klopt.
     */
    it('ruimt een achterhaalde knopmelding op als het daarna bij het mailen misgaat', async () => {
      const h = harness(
        {},
        {
          sender: {
            send: async () => {
              throw new Error('403 Forbidden');
            },
          },
        }
      );
      await h.problemen.record({
        itemId: 'i1',
        klanttitel: 'RSV Breda',
        datum: '2026-09-17',
        reden: 'oud',
        atMs: 1,
      });
      await runEvalKnop(h.deps, 'i1', BORD);
      expect(await h.problemen.list()).toEqual([]);
    });

    it('ruimt een oude melding op zodra de knop wél lukt', async () => {
      const h = harness();
      await h.problemen.record({
        itemId: 'i1',
        klanttitel: 'RSV Breda',
        datum: '2026-09-17',
        reden: 'oud',
        atMs: 1,
      });
      await runEvalKnop(h.deps, 'i1', BORD);
      expect(await h.problemen.list()).toEqual([]);
    });
  });
});
