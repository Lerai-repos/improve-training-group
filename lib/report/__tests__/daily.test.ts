import { describe, expect, it, vi } from 'vitest';

import { EVAL_COLUMNS, IE_STATUS_COLUMN, evalWriteFor } from '../record';
import { amsterdamHour, classify, previousDay, runDailyReports, shouldRunNow } from '../daily';

import type { EvaluationResponse } from '@lib/evaluations';
import type { LabelRecord } from '@lib/labels/read';
import { mailRecipients } from '@lib/mail';

import type { MailFailure, OutgoingMail } from '@lib/mail';
import type { DailyAgendaTraining, DailyDeps, DailyMailDeps } from '../daily';
import type { TrainingForReport } from '../training';

const AGENDA_2026 = '5087396949';
const AGENDA_2025 = '1703587792';

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
  trainerNamen: ['Jan'],
  labelCode: 'IT',
  rawIeCode: '251050',
  rawLabel: 'IT',
  ieStatus: '',
  datum: '2026-09-03',
  themaNamen: ['Onderhandelen'],
  trainerItemIds: ['t1'],
  accountmanager: 'Dirkje',
};

const response = (grade: number | null): EvaluationResponse => ({
  source: { documentId: 'x', sheetName: 'y', label: 'nl' },
  rowNumber: 2,
  rawCode: '251050',
  grade,
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
});

const agendaItem = (
  id: string,
  datum: string | null,
  boardId = AGENDA_2026,
  code = '251050'
): DailyAgendaTraining => ({
  trainingItemId: id,
  datum,
  boardId,
  ref: { trainingItemId: id, rawIeCode: code, clientKey: 'WE', themaKey: 'Onderh' },
});

const deps = (over: Partial<DailyDeps> = {}): DailyDeps => ({
  readAgenda: async () => [agendaItem('i1', '2026-09-01')],
  readTraining: async () => training,
  readLabels: async () => new Map([['IT', label]]),
  readResponses: async () => [response(8)],
  writeColumns: async () => undefined,
  ...over,
});

const options = { date: '2026-09-01', boardId: AGENDA_2026, dryRun: false };

describe('previousDay', () => {
  it('gaat een dag terug', () => {
    expect(previousDay('2026-09-02')).toBe('2026-09-01');
  });

  it('gaat over een maand- en jaargrens heen', () => {
    expect(previousDay('2026-09-01')).toBe('2026-08-31');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });

  it('kent schrikkeljaren', () => {
    expect(previousDay('2028-03-01')).toBe('2028-02-29');
  });

  /**
   * De reden dat dit op de datum rekent en niet 24 uur aftrekt: de nacht van de
   * zomertijdovergang duurt 23 uur en die van de wintertijd 25.
   */
  it('klopt rond beide tijdswissels', () => {
    expect(previousDay('2026-03-30')).toBe('2026-03-29');
    expect(previousDay('2026-10-26')).toBe('2026-10-25');
  });
});

describe('classify', () => {
  const GEEN: ReadonlySet<string> = new Set();

  /**
   * DE reden dat dit apart bestaat. Bij een botsende code houdt de toekenning de reacties
   * tegen, dus de lijst is leeg terwijl ze bestaan. Als `no_responses` classificeren zet
   * `Onvindbaar` en nul respondenten op het bord — onwaar, en het stuurt ITG naar de
   * verkeerde reparatie.
   */
  it('meldt een dubbelzinnige code apart van geen reacties', () => {
    const result = classify(training, label, [], new Set(['i1']));
    expect(result.kind).toBe('ambiguous_code');
  });

  it('kijkt naar dubbelzinnigheid vóór de lege lijst', () => {
    expect(classify(training, label, [], new Set(['i1'])).kind).not.toBe('no_responses');
  });

  it('rekent het gemiddelde over de ingevulde cijfers', () => {
    const result = classify(training, label, [response(8), response(7), response(null)], GEEN);
    expect(result).toEqual({ kind: 'ok', responseCount: 3, gemiddelde: '7.5' });
  });

  /** Het aantal respondenten telt élke rij, ook zonder cijfer — zoals legacy. */
  it('telt reacties zonder cijfer mee in het aantal', () => {
    const result = classify(training, label, [response(null), response(null)], GEEN);
    expect(result).toEqual({ kind: 'ok', responseCount: 2, gemiddelde: null });
  });

  it('meldt een onbekend label', () => {
    expect(classify({ ...training, labelCode: null }, undefined, [response(8)], GEEN).kind).toBe(
      'unknown_label'
    );
  });

  it('meldt een training zonder trainer', () => {
    expect(classify({ ...training, trainerNamen: [] }, label, [response(8)], GEEN).kind).toBe(
      'missing_trainer'
    );
  });

  it('meldt een training zonder code apart van een zonder reacties', () => {
    expect(classify({ ...training, rawIeCode: null }, label, [], GEEN).kind).toBe('no_code');
    expect(classify(training, label, [], GEEN).kind).toBe('no_responses');
  });
});

describe('evalWriteFor', () => {
  const leeg = { ieStatus: '' };

  it('schrijft cijfer en aantal bij een geslaagde run', () => {
    const write = evalWriteFor({ kind: 'ok', responseCount: 30, gemiddelde: '8.0' }, leeg);
    expect(write.values).toEqual({
      [EVAL_COLUMNS.respondenten]: 30,
      [EVAL_COLUMNS.eindcijfer]: 8,
    });
  });

  /**
   * WIST het cijfer in plaats van het weg te laten. Weglaten zou een cijfer van een
   * eerdere run laten staan naast het nieuwe aantal — verouderd en niet als zodanig
   * herkenbaar.
   */
  it('wist het cijfer als niemand er een gaf, maar schrijft het aantal wel', () => {
    const write = evalWriteFor({ kind: 'ok', responseCount: 3, gemiddelde: null }, leeg);
    expect(write.values).toEqual({
      [EVAL_COLUMNS.respondenten]: 3,
      [EVAL_COLUMNS.eindcijfer]: '',
    });
  });

  it('zet de status op Onvindbaar bij nul reacties en wist een oud cijfer', () => {
    const write = evalWriteFor({ kind: 'no_responses' }, leeg);
    expect(write.values[IE_STATUS_COLUMN]).toEqual({ label: 'Onvindbaar' });
    expect(write.values[EVAL_COLUMNS.respondenten]).toBe(0);
    expect(write.values[EVAL_COLUMNS.eindcijfer]).toBe('');
  });

  /**
   * De herstelvolgorde: eerst nul reacties (`Onvindbaar`), later komen ze alsnog binnen.
   * Dat MELDEN, niet stil oplossen — er is op dit bord geen neutrale waarde om naar terug
   * te zetten, want "wissen" schrijft het label `IE` en dat betekent iets in ITG's
   * werkstroom.
   */
  /**
   * De herstelvolgorde: eerst nul reacties (`Onvindbaar`), later komen ze alsnog binnen.
   * `Onvindbaar` is dan aantoonbaar onwaar en gaat terug naar de neutrale restbak `IE`,
   * waar ITG's gewone stroom hem weer oppakt.
   */
  it('overschrijft een achterhaalde Onvindbaar met de neutrale waarde', () => {
    const write = evalWriteFor(
      { kind: 'ok', responseCount: 12, gemiddelde: '7.9' },
      { ieStatus: 'Onvindbaar' }
    );
    expect(write.values[IE_STATUS_COLUMN]).toEqual({ label: 'IE' });
    expect(write.summary).toContain('Onvindbaar → IE');
  });

  /** Maar NOOIT een status van ITG's eigen werkstroom of van de mailstap. */
  it.each(['Verzonden', 'Staat klaar', 'IE', 'Geen (deze sessie)', 'Aanmaken'])(
    'laat de status %j met rust bij een geslaagde run',
    (huidig) => {
      const write = evalWriteFor(
        { kind: 'ok', responseCount: 12, gemiddelde: '7.9' },
        { ieStatus: huidig }
      );
      expect(write.values[IE_STATUS_COLUMN]).toBeUndefined();
    }
  );

  /**
   * Zonder code is er nooit een evaluatie uitgezet. `Onvindbaar` zou een zoekactie
   * suggereren die niet heeft plaatsgevonden.
   */
  it.each(['no_code', 'unknown_label', 'missing_trainer', 'ambiguous_code', 'not_found'] as const)(
    'schrijft niets bij %s',
    (kind) => {
      expect(evalWriteFor({ kind }, leeg)).toMatchObject({ values: {} });
    }
  );
});

describe('runDailyReports', () => {
  it('verwerkt de trainingen van die dag en schrijft terug', async () => {
    const writeColumns = vi.fn(async () => undefined);
    const report = await runDailyReports(deps({ writeColumns }), options);
    expect(report.considered).toBe(1);
    expect(report.written).toBe(1);
    expect(report.totals.ok).toBe(1);
    expect(writeColumns).toHaveBeenCalledWith('i1', {
      [EVAL_COLUMNS.respondenten]: 1,
      [EVAL_COLUMNS.eindcijfer]: 8,
    });
  });

  it('slaat trainingen van een andere dag over', async () => {
    const report = await runDailyReports(
      deps({ readAgenda: async () => [agendaItem('i1', '2026-08-31')] }),
      options
    );
    expect(report.considered).toBe(0);
  });

  /** Een oude jaargang met dezelfde datum is historie; die status hoort niet te bewegen. */
  it('slaat een training van een ander agendabord over', async () => {
    const report = await runDailyReports(
      deps({ readAgenda: async () => [agendaItem('i1', '2026-09-01', AGENDA_2025)] }),
      options
    );
    expect(report.considered).toBe(0);
  });

  it('leest de sheets niet als er die dag niets was', async () => {
    const readResponses = vi.fn(async () => []);
    await runDailyReports(deps({ readAgenda: async () => [], readResponses }), options);
    expect(readResponses).not.toHaveBeenCalled();
  });

  it('schrijft niets in een droogloop, maar rapporteert wel', async () => {
    const writeColumns = vi.fn(async () => undefined);
    const report = await runDailyReports(deps({ writeColumns }), { ...options, dryRun: true });
    expect(writeColumns).not.toHaveBeenCalled();
    expect(report.written).toBe(0);
    expect(report.totals.ok).toBe(1);
    expect(report.lines[0]?.wrote).toBe(false);
  });

  it('zet Onvindbaar op een training zonder reacties', async () => {
    const writeColumns = vi.fn(async () => undefined);
    await runDailyReports(deps({ readResponses: async () => [], writeColumns }), options);
    expect(writeColumns).toHaveBeenCalledWith('i1', {
      [IE_STATUS_COLUMN]: { label: 'Onvindbaar' },
      [EVAL_COLUMNS.respondenten]: 0,
      [EVAL_COLUMNS.eindcijfer]: '',
    });
  });

  /**
   * De toekenning gaat over de hele agenda zodat een botsende code van een ANDERE klant
   * geen reacties laat lekken. Maar zo'n botsing is géén `no_responses`: de reacties
   * bestaan, ze zijn alleen niet toe te wijzen. Er wordt dan NIETS naar het bord
   * geschreven — geen `Onvindbaar`, geen nul.
   */
  it('meldt een botsende code als ambiguous_code en schrijft niets', async () => {
    const report = await runDailyReports(
      deps({
        readAgenda: async () => [
          agendaItem('i1', '2026-09-01'),
          {
            ...agendaItem('i2', '2026-08-20'),
            ref: {
              trainingItemId: 'i2',
              rawIeCode: '251050',
              clientKey: 'Ander',
              themaKey: 'Anders',
            },
          },
        ],
      }),
      options
    );
    expect(report.totals.ambiguous_code).toBe(1);
    expect(report.totals.no_responses).toBe(0);
    expect(report.totals.ok).toBe(0);
    expect(report.written).toBe(0);
    expect(report.lines[0]?.wrote).toBe(false);
  });

  it('overleeft een item dat tussendoor verdwijnt', async () => {
    const report = await runDailyReports(deps({ readTraining: async () => null }), options);
    expect(report.totals.not_found).toBe(1);
    expect(report.lines[0]?.wrote).toBe(false);
  });
});

describe('shouldRunNow', () => {
  /**
   * Vercel leest cron-expressies altijd in UTC en Amsterdam schuift met de zomertijd. Twee
   * regels (`30 4` en `30 5` UTC) leveren samen het hele jaar precies één aanroep om 06:30
   * Amsterdam op; deze grendel laat de andere gaan.
   */
  it('laat de ZOMERtijd-aanroep door en stopt de andere', () => {
    // Juli: Amsterdam is UTC+2.
    expect(shouldRunNow(new Date('2026-07-15T04:30:00Z'))).toBe(true);
    expect(shouldRunNow(new Date('2026-07-15T05:30:00Z'))).toBe(false);
  });

  it('laat de WINTERtijd-aanroep door en stopt de andere', () => {
    // Januari: Amsterdam is UTC+1.
    expect(shouldRunNow(new Date('2026-01-15T05:30:00Z'))).toBe(true);
    expect(shouldRunNow(new Date('2026-01-15T04:30:00Z'))).toBe(false);
  });

  /** Precies één van de twee aanroepen komt door, elke dag van het jaar. */
  it('laat op elke dag van het jaar precies één van de twee door', () => {
    for (let dag = 0; dag < 365; dag += 1) {
      const basis = new Date(Date.UTC(2026, 0, 1 + dag));
      const vroeg = new Date(`${basis.toISOString().slice(0, 10)}T04:30:00Z`);
      const laat = new Date(`${basis.toISOString().slice(0, 10)}T05:30:00Z`);
      const doorgelaten = [vroeg, laat].filter(shouldRunNow).length;
      expect(doorgelaten, basis.toISOString().slice(0, 10)).toBe(1);
    }
  });

  it('weigert elk ander uur', () => {
    expect(shouldRunNow(new Date('2026-07-15T09:30:00Z'))).toBe(false);
    expect(shouldRunNow(new Date('2026-07-15T22:00:00Z'))).toBe(false);
  });
});

describe('amsterdamHour', () => {
  it('kent zomer- en wintertijd', () => {
    expect(amsterdamHour(new Date('2026-07-15T04:30:00Z'))).toBe(6);
    expect(amsterdamHour(new Date('2026-01-15T04:30:00Z'))).toBe(5);
  });

  /** Middernacht moet 0 zijn en niet 24 — `hour12:false` levert in sommige locales `24`. */
  it('geeft middernacht als 0', () => {
    expect(amsterdamHour(new Date('2026-07-14T22:00:00Z'))).toBe(0);
  });
});

/**
 * De mailkant van de dagjob.
 *
 * De teksten zelf zijn getest in `lib/mail`; hier gaat het om de bedrading: welke uitkomst
 * welke variant oplevert, dat de grendel voorkomt dat een herstelrun dubbel stuurt, en dat
 * een mislukte mail de dag niet stilzet maar wél zichtbaar wordt.
 */
describe('de mails vanuit de dagjob', () => {
  const mailHarness = (over: Partial<DailyMailDeps> = {}) => {
    const verstuurd: OutgoingMail[] = [];
    /** Kort geclaimd (verzending loopt) tegenover duurzaam bevestigd (verzending gelukt). */
    const geclaimd = new Set<string>();
    const bevestigd = new Set<string>();
    /** Wat de dagelijkse controle morgen op het Systeem-bord zou zetten. */
    const gemeld = new Map<string, MailFailure>();
    const mail: DailyMailDeps = {
      /**
       * De ECHTE bestemmingen als standaard, want `isRedirected` vergelijkt daarmee. Met
       * verzonnen adressen zou elke test als "omgeleid" tellen en zou de test die juist een
       * omleiding aantoont niets meer bewijzen.
       */
      recipients: mailRecipients({}),
      sender: {
        send: async (m) => {
          verstuurd.push(m);
        },
      },
      guard: {
        claim: async (itemId, variant) => {
          const sleutel = `${itemId}:${variant}`;
          if (geclaimd.has(sleutel)) {
            // Bevestigd = aantoonbaar verstuurd; anders is een andere run nog bezig.
            return { kind: 'bezet', reden: bevestigd.has(sleutel) ? 'verstuurd' : 'bezig' };
          }
          geclaimd.add(sleutel);
          return { kind: 'claimed', token: `token:${sleutel}` };
        },
        confirm: async (itemId, variant, token) => {
          const sleutel = `${itemId}:${variant}`;
          // Alleen de eigenaar mag bevestigen; een vreemd token hoort af te ketsen.
          if (token !== `token:${sleutel}`) {
            return 'verloren';
          }
          bevestigd.add(sleutel);
          return 'ok';
        },
        release: async (itemId, variant, token) => {
          const sleutel = `${itemId}:${variant}`;
          if (token !== `token:${sleutel}`) {
            return 'verloren';
          }
          geclaimd.delete(sleutel);
          return 'ok';
        },
      },
      failures: {
        record: async (f) => {
          gemeld.set(`${f.itemId}:${f.variant}`, f);
        },
        clear: async (itemId, variant) => {
          gemeld.delete(`${itemId}:${variant}`);
        },
        list: async () => [...gemeld.values()],
      },
      renderer: { render: async () => new Uint8Array([1, 2, 3]) },
      readTrainerEmails: async () => ['jan@voorbeeld.nl'],
      nowMs: () => 1,
      ...over,
    };
    return { mail, verstuurd, geclaimd, bevestigd, gemeld };
  };

  it('stuurt bij een beoordeelde training twee mails, met het rapport erbij', async () => {
    const { mail, verstuurd } = mailHarness();
    const report = await runDailyReports(deps({ mail }), options);

    expect(report.mailed).toBe(2);
    expect(verstuurd.map((m) => m.to[0])).toEqual([
      'aanvragen@improvetraininggroup.nl',
      'backoffice@improvetraininggroup.nl',
    ]);
    expect(verstuurd.every((m) => m.attachment !== undefined)).toBe(true);
  });

  it('stuurt zonder reacties twee mails zónder bijlage', async () => {
    const { mail, verstuurd } = mailHarness();
    const report = await runDailyReports(deps({ mail, readResponses: async () => [] }), options);

    expect(report.mailed).toBe(2);
    expect(verstuurd.every((m) => m.attachment === undefined)).toBe(true);
    expect(verstuurd[0].subject).toContain('GEEN evaluaties');
  });

  /**
   * De vier overige uitkomsten schrijven ook niets naar het bord. Een mail zou hier iets
   * beweren wat niet waar is: zonder code is er nooit een evaluatie uitgezet, en bij een
   * dubbele code bestaan de reacties wél.
   */
  it('mailt niet bij een uitkomst die ook niets naar het bord schrijft', async () => {
    for (const kapot of [
      { ...training, rawIeCode: null },
      { ...training, labelCode: null },
      { ...training, trainerNamen: [] },
    ]) {
      const { mail, verstuurd } = mailHarness();
      const report = await runDailyReports(
        deps({ mail, readTraining: async () => kapot }),
        options
      );
      expect(report.mailed).toBe(0);
      expect(verstuurd).toHaveLength(0);
    }
  });

  it('verstuurt niets bij een droogloop, maar zegt wel wat het zou doen', async () => {
    const { mail, verstuurd, geclaimd } = mailHarness();
    const report = await runDailyReports(deps({ mail }), { ...options, dryRun: true });

    expect(verstuurd).toHaveLength(0);
    expect(report.mailed).toBe(0);
    // De grendel mag ook niet geclaimd worden: dan zou de échte run erdoor geblokkeerd zijn.
    expect(geclaimd.size).toBe(0);
    expect(report.lines[0].mailNote).toContain('zou');
  });

  it('stuurt bij een herstelrun niet nog een keer dezelfde mail', async () => {
    const { mail, verstuurd } = mailHarness();
    await runDailyReports(deps({ mail }), options);
    const tweede = await runDailyReports(deps({ mail }), options);

    expect(verstuurd).toHaveLength(2);
    expect(tweede.mailed).toBe(0);
    expect(tweede.lines[0].mailNote).toContain('al eerder verstuurd');
  });

  /**
   * Precies het geval waarvoor de sleutel de variant bevat: de reacties komen later alsnog
   * binnen, en dan hoort het rapport er alsnog uit te gaan.
   */
  it('stuurt de MET-mails alsnog als de reacties later binnenkomen', async () => {
    const { mail, verstuurd } = mailHarness();
    await runDailyReports(deps({ mail, readResponses: async () => [] }), options);
    expect(verstuurd).toHaveLength(2);

    const tweede = await runDailyReports(deps({ mail }), options);
    expect(tweede.mailed).toBe(2);
    expect(verstuurd).toHaveLength(4);
    expect(verstuurd[2].attachment).toBeDefined();
  });

  it('werkt het bord bij ook als het mailen mislukt', async () => {
    const { mail, geclaimd } = mailHarness({
      sender: {
        send: async () => {
          throw new Error('Exchange zei nee');
        },
      },
    });
    const writeColumns = vi.fn(async () => undefined);
    const report = await runDailyReports(deps({ mail, writeColumns }), options);

    expect(writeColumns).toHaveBeenCalledTimes(1);
    expect(report.written).toBe(1);
    expect(report.mailFailures).toEqual(['i1']);
    expect(report.lines[0].mailNote).toContain('Exchange zei nee');
    // De claim is teruggegeven, dus een herstelrun mag het opnieuw proberen.
    expect(geclaimd.size).toBe(0);
  });

  it('bevestigt de claim pas nadat beide mails weg zijn', async () => {
    const { mail, bevestigd } = mailHarness();
    await runDailyReports(deps({ mail }), options);
    expect([...bevestigd]).toEqual(['i1:met']);
  });

  /**
   * De claim mag NIET blijvend worden als het versturen mislukt: dan zou een half jaar lang
   * geen enkele herstelrun deze mail nog oppakken, zonder dat iemand iets merkt.
   */
  it('bevestigt niets als het versturen mislukt', async () => {
    const { mail, bevestigd } = mailHarness({
      sender: {
        send: async () => {
          throw new Error('Exchange zei nee');
        },
      },
    });
    await runDailyReports(deps({ mail }), options);
    expect(bevestigd.size).toBe(0);
  });

  it('bevestigt niets bij een droogloop', async () => {
    const { mail, bevestigd } = mailHarness();
    await runDailyReports(deps({ mail }), { ...options, dryRun: true });
    expect(bevestigd.size).toBe(0);
  });

  it('meldt waar de mails heen gingen', async () => {
    const { mail } = mailHarness();
    const report = await runDailyReports(deps({ mail }), options);
    expect(report.delivery).toEqual({
      klant: 'aanvragen@improvetraininggroup.nl',
      trainer: 'backoffice@improvetraininggroup.nl',
      redirected: false,
    });
  });

  /**
   * Blijft een testomleiding per ongeluk in productie staan, dan slaagt elke run terwijl elk
   * rapport naar een testadres gaat. Dat mag niet uit de uitkomst te halen zijn.
   */
  it('markeert een omgeleide bestemming als omgeleid', async () => {
    const { mail } = mailHarness({
      recipients: {
        klant: 'tim@lerai.nl',
        trainer: 'tim@lerai.nl',
        sender: 'automatisering@improvetraininggroup.nl',
      },
    });
    const report = await runDailyReports(deps({ mail }), options);
    expect(report.delivery?.redirected).toBe(true);
  });

  it('geeft ontbrekende huisstijl door in plaats van hem te laten verdwijnen', async () => {
    /**
     * Een onbruikbare URL laat `fetch` meteen struikelen, zonder netwerk — precies wat een
     * verlopen Monday-asset in het echt doet, en deterministisch in een test.
     */
    const kapotLogo = {
      ...label,
      logo: { id: 'a', name: 'logo.png', publicUrl: 'geen-url' },
    };
    const { mail, verstuurd } = mailHarness();
    const report = await runDailyReports(
      deps({ mail, readLabels: async () => new Map([['IT', kapotLogo]]) }),
      options
    );

    expect(report.lines[0].warnings).toHaveLength(1);
    expect(report.lines[0].warnings[0]).toContain('logo.png');
    expect(verstuurd[0].body.startsWith('LET OP')).toBe(true);
  });

  /**
   * Een mislukte mail komt NIET vanzelf goed: de dagjob kijkt alleen naar de dag ervoor. Zonder
   * melding blijft hij liggen tot iemand toevallig in een log kijkt.
   */
  it('laat een mislukte mail achter voor de dagelijkse controle', async () => {
    const { mail, gemeld } = mailHarness({
      sender: {
        send: async () => {
          throw new Error('Exchange zei nee');
        },
      },
    });
    await runDailyReports(deps({ mail }), options);

    expect([...gemeld.keys()]).toEqual(['i1:met']);
    expect(gemeld.get('i1:met')).toMatchObject({
      itemId: 'i1',
      variant: 'met',
      klanttitel: 'Onderhandelen',
      datum: '2026-09-03',
    });
    expect(gemeld.get('i1:met')?.reden).toContain('Exchange zei nee');
  });

  it('haalt de melding weg zodra dezelfde mail alsnog verstuurd is', async () => {
    let stuk = true;
    const { mail, gemeld } = mailHarness({
      sender: {
        send: async () => {
          if (stuk) {
            throw new Error('Exchange zei nee');
          }
        },
      },
    });
    await runDailyReports(deps({ mail }), options);
    expect(gemeld.size).toBe(1);

    stuk = false;
    await runDailyReports(deps({ mail }), options);
    expect(gemeld.size).toBe(0);
  });

  it('meldt niets bij een storing die vanzelf overwaait', async () => {
    // Eén weggevallen socket, tweede poging goed: geen mail kwijt, dus ook niets te melden.
    let n = 0;
    const { mail, gemeld } = mailHarness({
      sender: {
        send: async () => {
          n += 1;
          if (n === 1) {
            throw new Error('fetch failed', { cause: new Error('read ECONNRESET') });
          }
        },
      },
    });
    const report = await runDailyReports(deps({ mail }), options);
    expect(gemeld.size).toBe(0);
    expect(report.mailed).toBe(2);
    expect(report.lines[0].mailNote).toContain('opnieuw');
  });

  /**
   * De mails zijn dan al weg. Struikelt het opruimen van een oude melding daarna, dan mag dat
   * de verzending niet alsnog als mislukt boeken — een herstelrun zou allebei de mails nóg een
   * keer sturen om een hikje in KV.
   */
  it('boekt de verzending niet als mislukt als alleen het opruimen struikelt', async () => {
    const { mail, verstuurd, bevestigd } = mailHarness();
    const brekend: typeof mail.failures = {
      record: mail.failures.record,
      clear: async () => {
        throw new Error('redis hikje');
      },
      list: mail.failures.list,
    };
    const report = await runDailyReports(deps({ mail: { ...mail, failures: brekend } }), options);

    expect(report.mailFailures).toEqual([]);
    expect(report.mailed).toBe(2);
    expect(verstuurd).toHaveLength(2);
    expect([...bevestigd]).toEqual(['i1:met']);
    expect(report.lines[0].mailNote).toContain('oude melding bleef staan');
  });

  /**
   * De enige plek waar een blijven-hangen-melding nog weggaat. Lukte het opruimen destijds
   * niet, dan komt de verzendkant er nooit meer langs — die stopt bij een bevestigde claim.
   * Zonder dit blijft er voorgoed "mail mislukt" op het bord staan over een aangekomen mail.
   */
  it('ruimt een achterstallige melding op bij een herstelrun', async () => {
    let opruimenKapot = true;
    const { mail, gemeld, verstuurd } = mailHarness();
    const wankel: typeof mail.failures = {
      record: mail.failures.record,
      clear: async (itemId, variant) => {
        if (opruimenKapot) {
          throw new Error('redis hikje');
        }
        await mail.failures.clear(itemId, variant);
      },
      list: mail.failures.list,
    };
    // Een eerdere run liet een melding achter die niet opgeruimd kon worden.
    await wankel.record({
      itemId: 'i1',
      variant: 'met',
      klanttitel: 'Onderhandelen',
      datum: '2026-09-03',
      reden: 'fetch failed',
      atMs: 1,
    });

    const deps1 = deps({ mail: { ...mail, failures: wankel } });
    await runDailyReports(deps1, options);
    expect(gemeld.size).toBe(1);
    expect(verstuurd).toHaveLength(2);

    // De herstelrun verstuurt niets meer, maar ruimt de melding wél op.
    opruimenKapot = false;
    const tweede = await runDailyReports(deps1, options);
    expect(tweede.mailed).toBe(0);
    expect(verstuurd).toHaveLength(2);
    expect(gemeld.size).toBe(0);
    expect(tweede.lines[0].mailNote).toContain('al eerder verstuurd');
  });

  it('raakt niets aan terwijl een andere run nog bezig is', async () => {
    // 'bezig' is de voorzichtige lezing: dan is er nog niets bewezen om op te ruimen.
    const { mail, gemeld } = mailHarness();
    const blijftHangen: typeof mail.guard = {
      claim: async () => ({ kind: 'bezet', reden: 'bezig' }),
      confirm: mail.guard.confirm,
      release: mail.guard.release,
    };
    await mail.failures.record({
      itemId: 'i1',
      variant: 'met',
      klanttitel: 'Onderhandelen',
      datum: '2026-09-03',
      reden: 'fetch failed',
      atMs: 1,
    });

    const report = await runDailyReports(deps({ mail: { ...mail, guard: blijftHangen } }), options);
    expect(gemeld.size).toBe(1);
    expect(report.lines[0].mailNote).toContain('bezig');
  });

  /**
   * Juist bij een halve verzending is het getal belangrijk: de herstelrun stuurt de eerste
   * mail opnieuw, en `0 verstuurd` in het logboek verbergt dat.
   */
  it('houdt vast hoeveel er wél weg zijn als de tweede mail mislukt', async () => {
    let n = 0;
    const { mail } = mailHarness({
      sender: {
        send: async () => {
          n += 1;
          if (n === 2) {
            throw new Error('Exchange zei nee');
          }
        },
      },
    });
    const report = await runDailyReports(deps({ mail }), options);

    expect(report.mailed).toBe(1);
    expect(report.lines[0].mailed).toBe(1);
    expect(report.mailFailures).toEqual(['i1']);
    expect(report.lines[0].mailNote).toContain('1 van de 2 was al weg');
  });

  it('doet niets aan de mailkant als er geen verzender is aangesloten', async () => {
    const report = await runDailyReports(deps(), options);
    expect(report.mailed).toBe(0);
    expect(report.lines[0].mailNote).toBe('');
    expect(report.mailFailures).toEqual([]);
  });
});
