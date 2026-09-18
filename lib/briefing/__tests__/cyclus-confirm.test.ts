import { describe, expect, it } from 'vitest';

import { EMPTY_CHECKLIST } from '../blocks';
import { createMemoryChecklistStore, type ChecklistStore } from '../checklist-store';
import { createMemoryCyclusStore, type CyclusStore } from '../cyclus-bevestiging';
import { voerVerhuizingenUit } from '../cyclus-antwoorden';
import { bevestigCyclus } from '../cyclus-confirm';

import type { CyclusKandidaat } from '../cyclus';
import type { SavedChecklist } from '../answers';
import type { BriefingTraining } from '../types';

/**
 * Wat er gebeurt als de adviseur bevestigt welke sessies samen één briefing krijgen.
 *
 * De regel zelf staat in `cyclus.test.ts`. Hier gaat het om de gevolgen: wat er wordt
 * vastgelegd, wat er wordt geweigerd, en waar de al ingevulde antwoorden blijven.
 */

const TRAINING: BriefingTraining = {
  itemId: '900',
  naam: 'International School Almere',
  label: 'IT',
  brie: 'Aanmaken',
  opdrachtgever: 'International School Almere',
  themas: ['Moeilijke gesprekken'],
  trainingscodeMc: '',
  themaInhoud: '',
  klanttitel: 'Navigating difficult conversations II',
  duur: '4',
  datum: '2027-01-04',
  tijden: '09:00 - 13:00',
  groepsgrootte: '50',
  locatie: 'Almere',
  voertaal: 'ENG',
  klantcontactmoment: 'Teams',
  evaluatie: 'Nee',
  ieCode: '',
  accountmanager: null,
  contactpersoon: null,
  trainers: [
    { itemId: 't1', naam: 'Isabelle Zwetsloot', telefoon: '', isActeur: false, isCoTrainer: false },
  ],
  acteuraantal: null,
  opportunityItemId: 'opp1',
  achtergrond: 'Iets over de klant.',
  opdrachten: { trainingCycle: true, homework: false, preparatoryAssignment: false },
  cyclus: null,
  cyclusKeuze: null,
  missing: [],
};

const kandidaat = (itemId: string, datum: string, gearchiveerd = false): CyclusKandidaat => ({
  itemId,
  boardId: gearchiveerd ? '1703587792' : '5087396949',
  gearchiveerd,
  isCyclus: true,
  klanttitel: 'Navigating difficult conversations',
  themaIds: ['t1'],
  leadIds: ['t1'],
  coIds: [],
  trainerNamen: 'Isabelle Zwetsloot',
  datum,
  tijden: '09:00 - 13:00',
  locatie: 'Almere',
  groepsgrootte: '50',
});

const KANDIDATEN = [kandidaat('800', '2026-09-22'), kandidaat('900', '2027-01-04')];
/** Wat er in deze tests "op het scherm stond": alle sessies die een test kan gebruiken. */
const GETOOND = ['800', '900', '940', '950', '960'];

const antwoorden = (conceptInhoud: string): SavedChecklist => ({
  checklist: { ...EMPTY_CHECKLIST, conceptInhoud },
  actorItemIds: [],
  actorAnswered: true,
});

function bouw(over: { kandidaten?: readonly CyclusKandidaat[]; training?: BriefingTraining } = {}) {
  const cycli = createMemoryCyclusStore();
  /** Gekoppeld zoals in Redis: het hek van de checklist-store is de versie van het cyclusrecord. */
  const checklists = createMemoryChecklistStore(undefined, (key) => cycli.hekToken(key));
  return {
    cycli,
    checklists,
    deps: {
      readTraining: () => Promise.resolve(over.training ?? TRAINING),
      readKandidaten: () => Promise.resolve(over.kandidaten ?? KANDIDATEN),
      cycli,
      checklists,
    },
  };
}

describe('bevestigCyclus', () => {
  it('legt de aangevinkte sessies vast en geeft de gebundelde training terug', async () => {
    const { deps, cycli } = bouw();

    const uit = await bevestigCyclus(deps, { itemId: '900', gekozen: ['800', '900'], getoond: GETOOND });

    expect(uit.kind).toBe('ok');
    if (uit.kind !== 'ok') {
      return;
    }
    expect(uit.training.cyclus?.sessies.map((s) => s.itemId)).toEqual(['800', '900']);
    expect(uit.training.cyclusKeuze?.openstaand).toBe(false);
    expect(await cycli.read('opp1')).toEqual({
      groepen: [{ leden: ['800', '900'], anker: '800' }],
      beslist: { '800': ['800', '900'], '900': ['800', '900'] },
      verhuizingen: [],
    });
  });

  /** "Nee, dit is geen cyclus" moet blijven staan, anders komt de vraag elke keer terug. */
  it('legt ook een antwoord zonder groep vast', async () => {
    const { deps, cycli } = bouw();

    const uit = await bevestigCyclus(deps, { itemId: '900', gekozen: [], getoond: GETOOND });

    expect(uit.kind === 'ok' && uit.training.cyclus).toBeNull();
    expect(await cycli.read('opp1')).toEqual({ groepen: [], beslist: { '900': ['800', '900'] }, verhuizingen: [] });
  });

  it('weigert een sessie die niet onder deze opdracht staat', async () => {
    const { deps, cycli } = bouw();

    const uit = await bevestigCyclus(deps, { itemId: '900', gekozen: ['900', '123'], getoond: GETOOND });

    expect(uit).toEqual({
      kind: 'geweigerd',
      message: 'Deze sessies horen niet bij deze opdracht: 123.',
    });
    expect(await cycli.read('opp1')).toBeNull();
  });

  it('weigert een training zonder andere sessies', async () => {
    const { deps } = bouw({ kandidaten: [] });

    const uit = await bevestigCyclus(deps, { itemId: '900', gekozen: [], getoond: GETOOND });

    expect(uit.kind).toBe('geweigerd');
  });

  /**
   * De adviseur typt het programma op sessie 2 en bevestigt daarna de cyclus. Vanaf dat moment
   * leest de tab de antwoorden van sessie 1 — dus die tekst moet mee.
   */
  it('verhuist de al ingevulde antwoorden naar de eerste sessie', async () => {
    const { deps, checklists } = bouw();
    await checklists.save('900', { ...antwoorden('Programma van Isabelle'), token: 'absent' });

    await bevestigCyclus(deps, { itemId: '900', gekozen: ['800', '900'], getoond: GETOOND });

    expect((await checklists.read('800')).saved?.checklist.conceptInhoud).toBe(
      'Programma van Isabelle'
    );
  });

  /**
   * Nog een keer bevestigen mag niets kapotmaken: de antwoorden staan dan al op het anker en
   * blijven daar. Dit is ook het pad na een mislukte verhuizing — die tweede poging doet
   * alsnog wat de eerste niet afmaakte.
   */
  it('kan een tweede keer bevestigd worden zonder de antwoorden kwijt te raken', async () => {
    const { deps, checklists } = bouw();
    await checklists.save('900', { ...antwoorden('Programma van Isabelle'), token: 'absent' });

    await bevestigCyclus(deps, { itemId: '900', gekozen: ['800', '900'], getoond: GETOOND });
    await bevestigCyclus(deps, { itemId: '900', gekozen: ['800', '900'], getoond: GETOOND });

    expect((await checklists.read('800')).saved?.checklist.conceptInhoud).toBe(
      'Programma van Isabelle'
    );
  });

  /**
   * Gaat het verhuizen stuk, dan blijft de OPDRACHT in het record staan. De aanroep mislukt —
   * de adviseur hoort te weten dat het niet af is — maar het werk raakt niet zoek: elke
   * volgende lezing van de tab maakt het af.
   */
  it('bewaart een mislukte verhuizing als opdracht en maakt hem later af', async () => {
    const { deps, checklists, cycli } = bouw();
    await checklists.save('900', { ...antwoorden('Programma van Isabelle'), token: 'absent' });
    let stuk = true;
    const hapert: ChecklistStore = {
      read: (itemId) => checklists.read(itemId),
      save: (itemId, input) => {
        if (stuk) {
          stuk = false;
          return Promise.reject(new Error('KV even onbereikbaar'));
        }
        return checklists.save(itemId, input);
      },
      clear: (itemId, token) => checklists.clear(itemId, token),
    };

    await expect(
      bevestigCyclus({ ...deps, checklists: hapert }, { itemId: '900', gekozen: ['800', '900'], getoond: GETOOND })
    ).rejects.toThrow(/onbereikbaar/);
    expect((await checklists.read('800')).saved).toBeNull();
    expect((await cycli.read('opp1'))?.verhuizingen).toHaveLength(1);

    /** Zoals de tab dat doet bij het laden. */
    await voerVerhuizingenUit(cycli, checklists, 'opp1');

    expect((await checklists.read('800')).saved?.checklist.conceptInhoud).toBe(
      'Programma van Isabelle'
    );
    expect((await cycli.read('opp1'))?.verhuizingen).toEqual([]);
  });

  /**
   * Hetzelfde, maar met een cyclus die van vorm verandert: de bron ligt dan buiten de nieuwe
   * groep. De opdracht draagt die bron, dus ook dan is er niets meer uit te zoeken.
   */
  it('bewaart ook de bron uit de vorige groep in de opdracht', async () => {
    const kandidaten = [...KANDIDATEN, kandidaat('950', '2027-03-01')];
    const { deps, checklists, cycli } = bouw({ kandidaten });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['800', '900'], anker: '800' }],
      beslist: { '800': ['800', '900'], '900': ['800', '900'] },
      verhuizingen: [],
    }));
    await checklists.save('800', { ...antwoorden('Programma van de cyclus'), token: 'absent' });
    let stuk = true;
    const hapert: ChecklistStore = {
      read: (itemId) => checklists.read(itemId),
      save: (itemId, invoer) => {
        if (stuk) {
          stuk = false;
          return Promise.reject(new Error('KV even onbereikbaar'));
        }
        return checklists.save(itemId, invoer);
      },
      clear: (itemId, token) => checklists.clear(itemId, token),
    };

    await expect(
      bevestigCyclus({ ...deps, checklists: hapert }, { itemId: '900', gekozen: ['900', '950'], getoond: GETOOND })
    ).rejects.toThrow(/onbereikbaar/);
    expect((await cycli.read('opp1'))?.groepen).toEqual([{ leden: ['900', '950'], anker: '900' }]);

    await voerVerhuizingenUit(cycli, checklists, 'opp1');

    expect((await checklists.read('900')).saved?.checklist.conceptInhoud).toBe(
      'Programma van de cyclus'
    );
  });

  /**
   * Het programma van de andere cyclus staat nog onder haar GEARCHIVEERDE eerste sessie: het
   * anker is opgeschoven, maar die verhuizing gebeurt pas als die cyclus geopend wordt. Zoeken
   * we alleen op het anker, dan lijkt de groep leeg en verdwijnt de tekst.
   */
  it('vindt het programma ook als het nog onder de gearchiveerde sessie staat', async () => {
    const kandidaten = [
      ...KANDIDATEN,
      kandidaat('940', '2026-12-01', true),
      kandidaat('950', '2027-03-01'),
      kandidaat('960', '2027-04-01'),
    ];
    const { deps, checklists, cycli } = bouw({
      kandidaten,
      training: { ...TRAINING, itemId: '800' },
    });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['940', '950', '960'], anker: '940' }],
      beslist: { '940': [], '950': [], '960': [] },
      verhuizingen: [],
    }));
    await checklists.save('940', { ...antwoorden('Programma van cyclus 2'), token: 'absent' });

    await bevestigCyclus(deps, { itemId: '800', gekozen: ['800', '940'], getoond: GETOOND });

    expect((await checklists.read('950')).saved?.checklist.conceptInhoud).toBe(
      'Programma van cyclus 2'
    );
  });

  /**
   * Een collega bevestigt `[950, 960]` tussen ons lezen en ons schrijven in. De CAS-lus draait
   * dit blok dan opnieuw met díé stand — en dus moet ook de redding op die verse stand slaan,
   * niet op wat wij aan het begin lazen.
   */
  it('redt een cyclus die er pas tussen lezen en schrijven bij kwam', async () => {
    const kandidaten = [
      ...KANDIDATEN,
      kandidaat('950', '2027-03-01'),
      kandidaat('960', '2027-04-01'),
    ];
    const { deps, checklists, cycli } = bouw({
      kandidaten,
      training: { ...TRAINING, itemId: '800' },
    });
    await checklists.save('950', { ...antwoorden('Programma van de collega'), token: 'absent' });
    /** De eerste poging ziet nog niets; pas de tweede ziet de groep van de collega. */
    let pogingen = 0;
    const rebasend: CyclusStore = {
      read: (opp) => cycli.read(opp),
      readMetFence: (opp) => cycli.readMetFence(opp),
      update: async (opp, maak) => {
        pogingen += 1;
        if (pogingen === 1) {
          await maak(null);
          await cycli.update(opp, () => ({
            groepen: [{ leden: ['950', '960'], anker: '950' }],
            beslist: { '950': ['950', '960'], '960': ['950', '960'] },
            verhuizingen: [],
          }));
        }
        return await cycli.update(opp, maak);
      },
    };

    await bevestigCyclus(
      { ...deps, cycli: rebasend },
      { itemId: '800', gekozen: ['800', '900', '950'], getoond: GETOOND }
    );

    expect((await checklists.read('960')).saved?.checklist.conceptInhoud).toBe(
      'Programma van de collega'
    );
    expect((await cycli.read('opp1'))?.groepen).toEqual([{ leden: ['800', '900', '950'], anker: '800' }]);
  });

  /**
   * `[800, 900]` en `[950, 960]` staan vast; vanaf 800 wordt `[800, 900, 950]` bevestigd. Dan
   * raakt 960 zijn groep kwijt, terwijl het programma van die cyclus onder 950 stond — en 950
   * hoort nu bij een andere briefing. Zonder redding is die tekst voor niemand meer te zien.
   */
  it('redt het programma van een cyclus die door deze keuze uit elkaar valt', async () => {
    const kandidaten = [
      ...KANDIDATEN,
      kandidaat('950', '2027-03-01'),
      kandidaat('960', '2027-04-01'),
    ];
    const { deps, checklists, cycli } = bouw({ kandidaten, training: { ...TRAINING, itemId: '800' } });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['800', '900'], anker: '800' }, { leden: ['950', '960'], anker: '950' }],
      beslist: {
        '800': ['800', '900'],
        '900': ['800', '900'],
        '950': ['950', '960'],
        '960': ['950', '960'],
      },
      verhuizingen: [],
    }));
    await checklists.save('950', { ...antwoorden('Programma van cyclus 2'), token: 'absent' });

    await bevestigCyclus(deps, { itemId: '800', gekozen: ['800', '900', '950'], getoond: GETOOND });

    expect((await checklists.read('960')).saved?.checklist.conceptInhoud).toBe(
      'Programma van cyclus 2'
    );
    expect((await cycli.read('opp1'))?.groepen).toEqual([{ leden: ['800', '900', '950'], anker: '800' }]);
  });

  /**
   * Onder één opdracht kunnen twee cycli leven. De antwoorden van de ene mogen nooit in het
   * formulier van de andere belanden: dat is tekst over een training waar hij niet over gaat.
   */
  it('haalt geen antwoorden op uit een andere cyclus onder dezelfde opdracht', async () => {
    const kandidaten = [
      ...KANDIDATEN,
      kandidaat('950', '2027-03-01'),
      kandidaat('960', '2027-04-01'),
    ];
    const { deps, checklists, cycli } = bouw({ kandidaten });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['800', '900'], anker: '800' }],
      beslist: { '800': ['800', '900'], '900': ['800', '900'] },
      verhuizingen: [],
    }));
    await checklists.save('800', { ...antwoorden('Programma van cyclus 1'), token: 'absent' });

    await bevestigCyclus(deps, { itemId: '950', gekozen: ['950', '960'], getoond: GETOOND });

    expect((await checklists.read('950')).saved).toBeNull();
    expect((await cycli.read('opp1'))?.groepen).toEqual([{ leden: ['800', '900'], anker: '800' }, { leden: ['950', '960'], anker: '950' }]);
  });

  /**
   * `[800, 900, 950]` wordt vanaf 800 `[800, 900]`. Het eigen record van 950 is bij het opruimen
   * al een grafsteen geworden; als losse training moet 950 toch het programma meekrijgen.
   */
  it('geeft een lid dat uit de cyclus wordt gevinkt een kopie van de antwoorden', async () => {
    const kandidaten = [...KANDIDATEN, kandidaat('950', '2027-03-01')];
    const { deps, checklists, cycli } = bouw({
      kandidaten,
      training: { ...TRAINING, itemId: '800' },
    });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['800', '900', '950'], anker: '800' }],
      beslist: {},
      verhuizingen: [],
    }));
    await checklists.save('800', { ...antwoorden('Gedeeld programma'), token: 'absent' });
    /** Zoals na een lezing van de cyclus: alleen het anker heeft nog een levend record. */
    expect((await checklists.read('950')).saved).toBeNull();

    await bevestigCyclus(deps, { itemId: '800', gekozen: ['800', '900'], getoond: GETOOND });

    expect((await checklists.read('950')).saved?.checklist.conceptInhoud).toBe('Gedeeld programma');
    expect((await checklists.read('800')).saved?.checklist.conceptInhoud).toBe('Gedeeld programma');
  });

  /**
   * Nog niemand opende de tab sinds de cyclus gevormd werd, dus 950 draagt nog zijn record van
   * vóór de cyclus. Wordt 950 eruit gevinkt, dan mag dat restant niet winnen van het programma.
   */
  it('laat de gedeelde antwoorden winnen van een restant onder een vertrekkend lid', async () => {
    const kandidaten = [...KANDIDATEN, kandidaat('950', '2027-03-01')];
    const { deps, checklists, cycli } = bouw({
      kandidaten,
      training: { ...TRAINING, itemId: '800' },
    });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['800', '900', '950'], anker: '800' }],
      beslist: {},
      verhuizingen: [],
    }));
    await checklists.save('800', { ...antwoorden('Gedeeld programma'), token: 'absent' });
    await checklists.save('950', { ...antwoorden('Restant van vóór de cyclus'), token: 'absent' });

    await bevestigCyclus(deps, { itemId: '800', gekozen: ['800', '900'], getoond: GETOOND });

    expect((await checklists.read('950')).saved?.checklist.conceptInhoud).toBe('Gedeeld programma');
  });

  /** Hetzelfde voor een ándere cyclus die door deze keuze uit elkaar valt. */
  it('laat de gedeelde antwoorden ook winnen in een cyclus die uit elkaar valt', async () => {
    const kandidaten = [
      ...KANDIDATEN,
      kandidaat('950', '2027-03-01'),
      kandidaat('960', '2027-04-01'),
    ];
    const { deps, checklists, cycli } = bouw({
      kandidaten,
      training: { ...TRAINING, itemId: '800' },
    });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['800', '900'], anker: '800' }, { leden: ['950', '960'], anker: '950' }],
      beslist: {},
      verhuizingen: [],
    }));
    await checklists.save('950', { ...antwoorden('Programma van cyclus 2'), token: 'absent' });
    await checklists.save('960', { ...antwoorden('Restant van 960'), token: 'absent' });

    await bevestigCyclus(deps, { itemId: '800', gekozen: ['800', '900', '950'], getoond: GETOOND });

    expect((await checklists.read('960')).saved?.checklist.conceptInhoud).toBe(
      'Programma van cyclus 2'
    );
  });

  /**
   * Een sessie die ná het laden van de tab aan de opdracht gekoppeld is, heeft de adviseur nooit
   * gezien. Die mag niet als beoordeeld gelden, anders gaat de vraag er stil voor dicht.
   */
  it('markeert alleen wat op het scherm stond als beoordeeld', async () => {
    const kandidaten = [...KANDIDATEN, kandidaat('950', '2027-03-01')];
    const { deps, cycli } = bouw({ kandidaten });

    await bevestigCyclus(deps, { itemId: '900', gekozen: ['800', '900'], getoond: ['800', '900'] });

    expect((await cycli.read('opp1'))?.beslist).toEqual({
      '800': ['800', '900'],
      '900': ['800', '900'],
    });
  });

  it('weigert een aangevinkte sessie die niet op het scherm stond', async () => {
    const { deps } = bouw();

    const uit = await bevestigCyclus(deps, { itemId: '900', gekozen: ['800', '900'], getoond: ['900'] });

    expect(uit.kind).toBe('geweigerd');
  });

  /**
   * Het scenario uit de review: `[800, 900]` met de gedeelde antwoorden onder 800, terwijl 900
   * nog een restant heeft van vóór de cyclus. Vanaf 900 wordt het `[900, 950]` — en 900 is het
   * nieuwe anker. Het restant mag de gedeelde antwoorden niet verdringen.
   */
  it('laat een restant onder het nieuwe anker niet winnen van de gedeelde antwoorden', async () => {
    const kandidaten = [...KANDIDATEN, kandidaat('950', '2027-03-01')];
    const { deps, checklists, cycli } = bouw({ kandidaten });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['800', '900'], anker: '800' }],
      beslist: { '800': ['800', '900'], '900': ['800', '900'] },
      verhuizingen: [],
    }));
    await checklists.save('800', { ...antwoorden('Gedeeld programma'), token: 'absent' });
    await checklists.save('900', { ...antwoorden('Restant van 900'), token: 'absent' });

    await bevestigCyclus(deps, { itemId: '900', gekozen: ['900', '950'], getoond: GETOOND });

    expect((await checklists.read('900')).saved?.checklist.conceptInhoud).toBe(
      'Gedeeld programma'
    );
  });

  /**
   * De cyclus verandert van vorm: `[800, 900]` wordt vanaf 900 `[900, 950]`. De antwoorden
   * staan dan onder 800 — buiten de nieuwe groep — en moeten toch mee.
   */
  it('haalt de antwoorden op uit de vorige groep', async () => {
    const kandidaten = [...KANDIDATEN, kandidaat('950', '2027-03-01')];
    const { deps, checklists, cycli } = bouw({ kandidaten });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['800', '900'], anker: '800' }],
      beslist: { '800': ['800', '900'], '900': ['800', '900'] },
      verhuizingen: [],
    }));
    await checklists.save('800', { ...antwoorden('Programma van de cyclus'), token: 'absent' });

    await bevestigCyclus(deps, { itemId: '900', gekozen: ['900', '950'], getoond: GETOOND });

    expect((await checklists.read('900')).saved?.checklist.conceptInhoud).toBe(
      'Programma van de cyclus'
    );
  });

  /**
   * Eerste bevestiging, vanaf sessie 2, met tekst op beide sessies. De adviseur werkte op
   * sessie 2; wat er onder sessie 1 staat is een oude losse briefing. Zijn werk wint — en gaat
   * dus niet als restant de prullenbak in.
   */
  it('laat bij een eerste bevestiging de sessie van de adviseur winnen', async () => {
    const { deps, checklists } = bouw();
    await checklists.save('800', { ...antwoorden('Oude losse briefing'), token: 'absent' });
    await checklists.save('900', { ...antwoorden('Zojuist getypt op sessie 2'), token: 'absent' });

    await bevestigCyclus(deps, { itemId: '900', gekozen: ['800', '900'], getoond: GETOOND });

    expect((await checklists.read('800')).saved?.checklist.conceptInhoud).toBe(
      'Zojuist getypt op sessie 2'
    );
  });

  /** Bevestigd vanaf het anker zelf: dan is er niets te verdringen. */
  it('laat het anker met rust als er vanaf het anker bevestigd wordt', async () => {
    const { deps, checklists } = bouw({ training: { ...TRAINING, itemId: '800' } });
    await checklists.save('800', { ...antwoorden('Van sessie 1'), token: 'absent' });
    await checklists.save('900', { ...antwoorden('Van sessie 2'), token: 'absent' });

    await bevestigCyclus(deps, { itemId: '800', gekozen: ['800', '900'], getoond: GETOOND });

    expect((await checklists.read('800')).saved?.checklist.conceptInhoud).toBe('Van sessie 1');
  });
});
