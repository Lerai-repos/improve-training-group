import { describe, expect, it } from 'vitest';

import {
  aantalWoord,
  cyclusFeiten,
  documentSessies,
  eenmaligOfPerSessie,
  formatCyclusDatumTijd,
  formatCyclusDuur,
  formatCyclusTravel,
  parseCyclusVariant,
} from '../cyclus-document';

import type { BriefingSessie, BriefingTraining } from '../types';

const TRAINING: BriefingTraining = {
  trainingscodeMc: '',
  itemId: '1',
  naam: 'Reade',
  label: 'IT',
  brie: 'Aanmaken',
  opdrachtgever: 'Reade',
  themas: ['Intervisie communicatie'],
  themaInhoud: '',
  klanttitel: 'Intervisie',
  duur: '4 uur',
  datum: '2026-05-19',
  tijden: '13:15 - 17:15',
  groepsgrootte: '20 tot 25',
  locatie: 'Overtoom 283, 1054 HW Amsterdam',
  voertaal: 'NL',
  klantcontactmoment: 'Teams',
  evaluatie: 'Verzonden',
  ieCode: '260546',
  accountmanager: null,
  contactpersoon: null,
  trainers: [],
  acteuraantal: null,
  opportunityItemId: '2861309592',
  achtergrond: '',
  opdrachten: { trainingCycle: true, homework: false, preparatoryAssignment: false },
  cyclus: null,
  cyclusKeuze: null,
  cyclusVariant: '',
  missing: [],
};

const sessie = (over: Partial<BriefingSessie>): BriefingSessie => ({
  itemId: '1',
  boardId: '2026',
  gearchiveerd: false,
  datum: '2026-05-19',
  tijden: '13:15 - 17:15',
  locatie: 'Overtoom 283, 1054 HW Amsterdam',
  groepsgrootte: '20 tot 25',
  duur: '4 uur',
  ieCode: '260546',
  zonderThema: false,
  ...over,
});

/** Reade zoals hij in Monday staat: 19 mei 4 uur, 16 juni 3 uur, elk een eigen IE-code. */
const READE: BriefingTraining = {
  ...TRAINING,
  cyclus: {
    anker: '1',
    sessies: [
      sessie({}),
      sessie({
        itemId: '2',
        datum: '2026-06-16',
        tijden: '9.00-12.00',
        duur: '3 uur',
        ieCode: '260691',
      }),
    ],
  },
};

describe('parseCyclusVariant', () => {
  it('leest de vormen die Dirkje op de Opportunity zette', () => {
    expect(parseCyclusVariant('2x4u')).toEqual([4, 4]);
    expect(parseCyclusVariant('8+4u')).toEqual([8, 4]);
    expect(parseCyclusVariant('4+8u')).toEqual([4, 8]);
    expect(parseCyclusVariant('2x8u')).toEqual([8, 8]);
    expect(parseCyclusVariant('3x4u')).toEqual([4, 4, 4]);
    // Een variant die ITG er later bij zet, met spaties of "uur".
    expect(parseCyclusVariant('2 x 3,5 uur')).toEqual([3.5, 3.5]);
    expect(parseCyclusVariant('4+4+8u')).toEqual([4, 4, 8]);
  });

  it('zegt niets bij Nee, leeg of iets onherkenbaars', () => {
    expect(parseCyclusVariant('Nee')).toBeNull();
    expect(parseCyclusVariant('')).toBeNull();
    expect(parseCyclusVariant('4u')).toBeNull();
    expect(parseCyclusVariant('meerdere')).toBeNull();
  });
});

describe('documentSessies', () => {
  it('is leeg zonder cycluslabel en zonder bevestigde cyclus', () => {
    expect(
      documentSessies({ ...TRAINING, opdrachten: { ...TRAINING.opdrachten, trainingCycle: false } })
    ).toEqual([]);
  });

  it('neemt de bevestigde sessies over, met duur en IE-code per sessie', () => {
    const uit = documentSessies(READE);
    expect(uit.map((s) => [s.nummer, s.itemId, s.datum, s.uren, s.ieCode])).toEqual([
      [1, '1', '2026-05-19', 4, '260546'],
      [2, '2', '2026-06-16', 3, '260691'],
    ]);
  });

  it('is de training zelf als sessie 1 zolang er geen cyclus bevestigd is', () => {
    const uit = documentSessies(TRAINING);
    expect(uit).toHaveLength(1);
    expect(uit[0]).toMatchObject({
      nummer: 1,
      itemId: '1',
      datum: '2026-05-19',
      duur: '4 uur',
      uren: 4,
    });
  });

  it('vult ongeplande sessies aan als N.O.T.K. uit de Opportunity-variant', () => {
    // Reade toen de briefing werd gemaakt: alleen sessie 1 in Monday, Opportunity zegt 4+3u.
    const uit = documentSessies({ ...TRAINING, cyclusVariant: '4+3u' });
    expect(uit.map((s) => [s.nummer, s.itemId, s.uren])).toEqual([
      [1, '1', 4],
      [2, null, 3],
    ]);
  });

  it('laat de variant nooit winnen van wat er in Duur staat, en vult alleen aan', () => {
    const uit = documentSessies({
      ...READE,
      cyclusVariant: '3x8u',
      cyclus: { anker: '1', sessies: [sessie({}), sessie({ itemId: '2', duur: '2x 1 uur' })] },
    });
    expect(uit.map((s) => [s.itemId, s.uren])).toEqual([
      ['1', 4],
      ['2', 8],
      [null, 8],
    ]);
  });
});

describe('opmaak van de gegevenstabel', () => {
  it('Duur: "4 + 3 uur", of "2 x 4 uur" als de sessies even lang zijn', () => {
    expect(formatCyclusDuur(documentSessies(READE))).toBe('4 + 3 uur');
    expect(formatCyclusDuur(documentSessies({ ...TRAINING, cyclusVariant: '2x4u' }))).toBe(
      '2 x 4 uur'
    );
    expect(
      formatCyclusDuur(documentSessies({ ...TRAINING, duur: '3,5 uur', cyclusVariant: '' }))
    ).toBe('3,5 uur');
    expect(formatCyclusDuur(documentSessies({ ...TRAINING, duur: '2x 1 uur' }))).toBe(
      'Sessie 1: 2x 1 uur'
    );
  });

  it('Duur: geen half totaal als een sessie geen uren heeft — dan per sessie wat er staat', () => {
    const half = documentSessies({
      ...READE,
      cyclus: { anker: '1', sessies: [sessie({}), sessie({ itemId: '2', duur: '2x 1 uur' })] },
    });
    expect(formatCyclusDuur(half)).toBe('Sessie 1: 4 uur\nSessie 2: 2x 1 uur');
    expect(cyclusFeiten(half)).toEqual({ duur: '', aantal: 2 });
    const leeg = documentSessies({
      ...READE,
      cyclus: { anker: '1', sessies: [sessie({}), sessie({ itemId: '2', duur: '' })] },
    });
    expect(formatCyclusDuur(leeg)).toBe('Sessie 1: 4 uur\nSessie 2: ');
  });

  it('Datum & tijd: één regel per sessie, ongepland is N.O.T.K.', () => {
    expect(formatCyclusDatumTijd(documentSessies(READE))).toBe(
      'Sessie 1: 19 mei 2026; 13:15 - 17:15 uur\nSessie 2: 16 juni 2026; 09:00 - 12:00 uur'
    );
    expect(formatCyclusDatumTijd(documentSessies({ ...TRAINING, cyclusVariant: '2x4u' }))).toBe(
      'Sessie 1: 19 mei 2026; 13:15 - 17:15 uur\nSessie 2: N.O.T.K.'
    );
  });

  it('locatie en groepsgrootte één keer als ze gelijk zijn, anders per sessie', () => {
    const gelijk = documentSessies({ ...READE, cyclusVariant: '3x4u' });
    expect(eenmaligOfPerSessie(gelijk, (s) => s.locatie)).toBe('Overtoom 283, 1054 HW Amsterdam');

    const anders = documentSessies({
      ...READE,
      cyclus: {
        anker: '1',
        sessies: [sessie({}), sessie({ itemId: '2', locatie: 'Online' })],
      },
    });
    expect(eenmaligOfPerSessie(anders, (s) => s.locatie)).toBe(
      'Sessie 1: Overtoom 283, 1054 HW Amsterdam\nSessie 2: Online'
    );
    // Een lege waarde op één sessie is een verschil: niet de waarde van sessie 1 voor allebei.
    const leeg = documentSessies({
      ...READE,
      cyclus: { anker: '1', sessies: [sessie({}), sessie({ itemId: '2', groepsgrootte: '' })] },
    });
    expect(eenmaligOfPerSessie(leeg, (s) => s.groepsgrootte)).toBe(
      'Sessie 1: 20 tot 25\nSessie 2: '
    );
  });

  it('Km. / Reistijd: per sessie en een totaal, factureren per rit opgeteld', () => {
    const rit = { roundTripKm: 108, roundTripMinutes: 85, thresholdMinutes: 45 };
    expect(formatCyclusTravel([rit, rit])).toBe(
      'Per sessie: 108 km. / 85 min. (40 min. factureren)\n' +
        'Totaal: 216 km. / 170 min. (80 min. factureren)'
    );
    const elders = { roundTripKm: 20, roundTripMinutes: 30, thresholdMinutes: 45 };
    expect(formatCyclusTravel([rit, elders])).toBe(
      'Sessie 1: 108 km. / 85 min. (40 min. factureren)\n' +
        'Sessie 2: 20 km. / 30 min. (0 min. factureren)\n' +
        'Totaal: 128 km. / 115 min. (40 min. factureren)'
    );
  });

  it('Km. / Reistijd is niet af zolang een sessie geen route heeft', () => {
    const rit = { roundTripKm: 108, roundTripMinutes: 85, thresholdMinutes: 45 };
    expect(formatCyclusTravel([rit, undefined])).toBeNull();
    expect(formatCyclusTravel([])).toBeNull();
  });
});

describe('cyclusFeiten', () => {
  it('geeft de cijfers voor de cyclustekst', () => {
    expect(cyclusFeiten(documentSessies(READE))).toEqual({ duur: '4 + 3 uur', aantal: 2 });
    expect(cyclusFeiten([])).toBeNull();
    expect(aantalWoord(2)).toBe('twee');
    expect(aantalWoord(7)).toBe('7');
  });
});
