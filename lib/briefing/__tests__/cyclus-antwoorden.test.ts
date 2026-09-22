import { describe, expect, it } from 'vitest';

import { EMPTY_CHECKLIST } from '../blocks';
import { createMemoryChecklistStore, type ChecklistStore } from '../checklist-store';
import { metAnker, metVerhuizingen, type CyclusStore } from '../cyclus-bevestiging';
import { createMemoryCyclusStore } from '../cyclus-store';
import { ankerMetAntwoorden, raaktDezeCyclus, voerVerhuizingenUit } from '../cyclus-antwoorden';
import { moetZoeken } from '../load';

import type { SavedChecklist } from '../answers';
import type { BriefingSessie } from '../types';

/**
 * Waar de antwoorden van een cyclus staan als niemand iets bevestigt.
 *
 * Het anker is de eerste sessie die nog te schrijven is, en dat kan vanzelf verschuiven: bij de
 * jaarwisseling archiveert ITG de oude jaargang. Zonder herstel leest de tab dan een leeg
 * formulier terwijl het werk onder de gearchiveerde sessie staat.
 */

const sessie = (itemId: string, gearchiveerd = false): BriefingSessie => ({
  itemId,
  boardId: gearchiveerd ? '1703587792' : '5087396949',
  gearchiveerd,
  datum: gearchiveerd ? '2026-12-01' : '2027-01-10',
  tijden: '09:00 - 13:00',
  locatie: 'Almere',
  groepsgrootte: '12',
  duur: '',
  ieCode: '',
  zonderThema: false,
});

/** Zonder hek: de geheugen-checklist-store antwoordt `absent` en dat is precies dit token. */
const VRIJ = { key: 'briefing:cyclus:opp1', token: 'absent' };

const antwoorden = (conceptInhoud: string): SavedChecklist => ({
  checklist: { ...EMPTY_CHECKLIST, conceptInhoud },
  actorItemIds: [],
  actorAnswered: true,
});

describe('ankerMetAntwoorden', () => {
  it('geeft het vastgelegde anker terug en leest daar', async () => {
    const checklists = createMemoryChecklistStore();
    await checklists.save('nieuw', { ...antwoorden('Programma van de cyclus'), token: 'absent' });
    const training = {
      itemId: 'nieuw',
      cyclus: { sessies: [sessie('oud', true), sessie('nieuw')], anker: 'nieuw' },
    };

    const anker = await ankerMetAntwoorden(checklists, training, VRIJ);

    expect(anker).toEqual({ anker: 'nieuw', geblokkeerd: false, opnieuw: false });
  });

  it('is de training zelf zonder cyclus, en leest dan niets anders', async () => {
    const checklists = createMemoryChecklistStore();
    expect(await ankerMetAntwoorden(checklists, { itemId: '900', cyclus: null }, VRIJ)).toEqual({
      anker: '900',
      geblokkeerd: false,
      opnieuw: false,
    });
  });

  /** Onleesbare antwoorden onder het anker zelf: de grendel. */
  it('meldt het als het anker niet te lezen is', async () => {
    const echt = createMemoryChecklistStore();
    const kapot: ChecklistStore = {
      read: (itemId) =>
        itemId === 'nieuw'
          ? Promise.resolve({ saved: null, token: 'rommel', unreadable: true })
          : echt.read(itemId),
      save: (itemId, invoer) => echt.save(itemId, invoer),
      clear: (itemId, token) => echt.clear(itemId, token),
    };

    const uit = await ankerMetAntwoorden(
      kapot,
      {
        itemId: 'nieuw',
        cyclus: { sessies: [sessie('oud', true), sessie('nieuw')], anker: 'nieuw' },
      },
      VRIJ
    );

    expect(uit).toEqual({ anker: 'nieuw', geblokkeerd: true, opnieuw: false });
  });
});

/**
 * De jaarwisseling: het anker staat op een gearchiveerd bord. De lading legt dan een verhuizing
 * vast — het oude anker is gezaghebbend — en verplaatst het anker in het record. Dat is geen
 * afleiding meer bij het lezen: een lid met een restant van vóór de cyclus kan de gedeelde
 * antwoorden niet meer verdringen.
 */
describe('jaarwisseling als vastgelegde verhuizing', () => {
  it('verplaatst de antwoorden van het oude naar het nieuwe anker, ook over een restant heen', async () => {
    const cycli = createMemoryCyclusStore();
    const checklists = createMemoryChecklistStore(undefined, (key) => cycli.hekToken(key));
    await checklists.save('oud', { ...antwoorden('Programma van de cyclus'), token: 'absent' });
    await checklists.save('nieuw', {
      ...antwoorden('Restant van vóór de cyclus'),
      token: 'absent',
    });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['oud', 'nieuw'], anker: 'oud' }],
      beslist: {},
      verhuizingen: [],
    }));

    /** Wat `readBriefingMetCyclus` doet zodra het ziet dat `oud` gearchiveerd is. */
    await cycli.update('opp1', (stand) =>
      metVerhuizingen(
        metAnker(
          stand ?? { groepen: [], beslist: {}, verhuizingen: [] },
          ['oud', 'nieuw'],
          'nieuw'
        ),
        [{ naar: 'nieuw', bronnen: ['oud'], gezaghebbend: 'oud' }]
      )
    );
    await voerVerhuizingenUit(cycli, checklists, 'opp1');

    expect((await cycli.read('opp1'))?.groepen[0]?.anker).toBe('nieuw');
    expect((await checklists.read('nieuw')).saved?.checklist.conceptInhoud).toBe(
      'Programma van de cyclus'
    );
  });
});

describe('ankerMetAntwoorden — één levend record per cyclus', () => {
  /**
   * B kwam bij de cyclus met een eigen, ouder record. Niemand leest dat meer, maar zodra B het
   * anker zou worden ging het weer voor "de antwoorden" door. Dus weg ermee — met een grafsteen.
   */
  it('ruimt het record van een ander lid op zodra het anker de antwoorden heeft', async () => {
    const checklists = createMemoryChecklistStore();
    await checklists.save('a', { ...antwoorden('Gedeeld programma'), token: 'absent' });
    await checklists.save('b', { ...antwoorden('Oud restant van b'), token: 'absent' });

    await ankerMetAntwoorden(
      checklists,
      {
        itemId: 'a',
        cyclus: { sessies: [sessie('a'), { ...sessie('b'), datum: '2027-02-01' }], anker: 'a' },
      },
      VRIJ
    );

    expect((await checklists.read('a')).saved?.checklist.conceptInhoud).toBe('Gedeeld programma');
    expect((await checklists.read('b')).saved).toBeNull();
    expect((await checklists.read('b')).unreadable).toBe(false);
  });

  it('ruimt niets op zolang het anker zelf leeg is', async () => {
    const checklists = createMemoryChecklistStore();
    await checklists.save('b', { ...antwoorden('Enige exemplaar'), token: 'absent' });

    /** Het anker is leeg: dan blijft het record van b staan, er wordt niets weggegooid. */
    await ankerMetAntwoorden(
      checklists,
      {
        itemId: 'a',
        cyclus: { sessies: [sessie('a'), { ...sessie('b'), datum: '2027-02-01' }], anker: 'a' },
      },
      VRIJ
    );

    expect((await checklists.read('b')).saved?.checklist.conceptInhoud).toBe('Enige exemplaar');
  });
});

describe('ankerMetAntwoorden — gehekt op de cyclusstand', () => {
  /**
   * De review-race: een lezing laadde `[a, b]` (anker a) en hing even stil. Een collega maakte er
   * `[b, c]` van en verhuisde de antwoorden naar b. De oude lezing komt terug en wil b als "lid"
   * opruimen — maar haar cyclusstand is verouderd, dus het hek houdt het tegen.
   */
  it('ruimt niets op als de cyclus intussen veranderd is', async () => {
    const cycli = createMemoryCyclusStore();
    const checklists = createMemoryChecklistStore(undefined, (key) => cycli.hekToken(key));
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['a', 'b'], anker: 'a' }],
      beslist: {},
      verhuizingen: [],
    }));
    const { fence: oud } = await cycli.readMetFence('opp1');
    await checklists.save('a', { ...antwoorden('Gedeeld programma'), token: 'absent' });

    /** De collega: nieuwe indeling, antwoorden naar b. */
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['b', 'c'], anker: 'b' }],
      beslist: {},
      verhuizingen: [],
    }));
    await checklists.save('b', { ...antwoorden('Gedeeld programma'), token: 'absent' });

    /** De oude lezing, met haar verouderde stand én hek. */
    const uit = await ankerMetAntwoorden(
      checklists,
      {
        itemId: 'a',
        cyclus: { sessies: [sessie('a'), { ...sessie('b'), datum: '2027-02-01' }], anker: 'a' },
      },
      oud
    );

    expect((await checklists.read('b')).saved?.checklist.conceptInhoud).toBe('Gedeeld programma');
    /** En de oude lezing hoort te horen dat ze niet meer bij de huidige stand past. */
    expect(uit.opnieuw).toBe(true);
  });
});

describe('voerVerhuizingenUit', () => {
  const opdracht = { naar: 'nieuw', bronnen: ['oud', 'nieuw'] };

  it('voert de opdracht uit en haalt hem weg', async () => {
    const cycli = createMemoryCyclusStore();
    const checklists = createMemoryChecklistStore(undefined, (key) => cycli.hekToken(key));
    await checklists.save('oud', { ...antwoorden('Programma'), token: 'absent' });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['oud', 'nieuw'], anker: 'nieuw' }],
      beslist: {},
      verhuizingen: [opdracht],
    }));

    expect(await voerVerhuizingenUit(cycli, checklists, 'opp1')).toEqual({
      geblokkeerd: [],
      opnieuw: false,
    });

    expect((await checklists.read('nieuw')).saved?.checklist.conceptInhoud).toBe('Programma');
    expect((await cycli.read('opp1'))?.verhuizingen).toEqual([]);
  });

  /**
   * `[A, B]` met de gedeelde antwoorden onder A; B draagt nog een restant van vóór de cyclus. Wordt
   * B het anker, dan mag dat restant de gedeelde antwoorden niet verdringen.
   */
  it('laat de gezaghebbende bron winnen van een restant onder het nieuwe anker', async () => {
    const cycli = createMemoryCyclusStore();
    const checklists = createMemoryChecklistStore(undefined, (key) => cycli.hekToken(key));
    await checklists.save('a', { ...antwoorden('Gedeeld programma'), token: 'absent' });
    await checklists.save('b', { ...antwoorden('Restant van b'), token: 'absent' });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['b', 'c'], anker: 'b' }],
      beslist: {},
      verhuizingen: [{ naar: 'b', bronnen: ['b', 'c', 'a'], gezaghebbend: 'a' }],
    }));

    await voerVerhuizingenUit(cycli, checklists, 'opp1');

    expect((await checklists.read('b')).saved?.checklist.conceptInhoud).toBe('Gedeeld programma');
  });

  /**
   * Een keten: `A → B` en daarna `B → D`. Is A onleesbaar, dan mag `B → D` niet alvast draaien —
   * die vindt B leeg, wordt weggestreept, en zodra A weer leest stoppen de antwoorden op B terwijl
   * het anker D is.
   */
  it('stopt bij de eerste opdracht die niet lukt en houdt de rest vast', async () => {
    const cycli = createMemoryCyclusStore();
    const echt = createMemoryChecklistStore(undefined, (key) => cycli.hekToken(key));
    const kapot: ChecklistStore = {
      read: (itemId) =>
        itemId === 'a'
          ? Promise.resolve({ saved: null, token: 'rommel', unreadable: true })
          : echt.read(itemId),
      save: (itemId, invoer) => echt.save(itemId, invoer),
      clear: (itemId, token) => echt.clear(itemId, token),
    };
    const keten = [
      { naar: 'b', bronnen: ['a'], gezaghebbend: 'a' },
      { naar: 'd', bronnen: ['b'], gezaghebbend: 'b' },
    ];
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['b', 'd'], anker: 'd' }],
      beslist: {},
      verhuizingen: keten,
    }));

    const uit = await voerVerhuizingenUit(cycli, kapot, 'opp1');

    expect(uit.geblokkeerd).toContain('a');
    /** Ook D telt als geblokkeerd: zijn cyclus gaat op slot in plaats van een leeg formulier. */
    expect(uit.geblokkeerd).toContain('d');
    expect((await cycli.read('opp1'))?.verhuizingen).toEqual(keten);
  });

  /**
   * Twee cycli onder één opdracht. Een onleesbaar record bij de ene (`A → B`) mag de verhuizing
   * van de andere (`C → D`) niet ophouden — anders opent D leeg en bewerkbaar, en overschrijft
   * `C → D` later wat daar getypt is.
   */
  it('voert een onafhankelijke opdracht van een andere cyclus wél uit', async () => {
    const cycli = createMemoryCyclusStore();
    const echt = createMemoryChecklistStore(undefined, (key) => cycli.hekToken(key));
    await echt.save('c', { ...antwoorden('Programma van cyclus 2'), token: 'absent' });
    const kapot: ChecklistStore = {
      read: (itemId) =>
        itemId === 'a'
          ? Promise.resolve({ saved: null, token: 'rommel', unreadable: true })
          : echt.read(itemId),
      save: (itemId, invoer) => echt.save(itemId, invoer),
      clear: (itemId, token) => echt.clear(itemId, token),
    };
    await cycli.update('opp1', () => ({
      groepen: [
        { leden: ['a', 'b'], anker: 'b' },
        { leden: ['c', 'd'], anker: 'd' },
      ],
      beslist: {},
      verhuizingen: [
        { naar: 'b', bronnen: ['a'], gezaghebbend: 'a' },
        { naar: 'd', bronnen: ['c'], gezaghebbend: 'c' },
      ],
    }));

    const uit = await voerVerhuizingenUit(cycli, kapot, 'opp1');

    expect((await echt.read('d')).saved?.checklist.conceptInhoud).toBe('Programma van cyclus 2');
    expect(uit.geblokkeerd).not.toContain('d');
    expect((await cycli.read('opp1'))?.verhuizingen).toEqual([
      { naar: 'b', bronnen: ['a'], gezaghebbend: 'a' },
    ]);
  });

  /**
   * De review-race: een collega verandert de cyclus tussen het lezen van het record en de
   * schrijfactie. Het hek houdt het kopiëren tegen — en dan mag de opdracht niet als "gedaan"
   * worden weggestreept, want er is niets verhuisd.
   */
  it('houdt een opdracht vast waarvan het hek de schrijfactie tegenhield', async () => {
    const cycli = createMemoryCyclusStore();
    let hekVersie = 'versie-oud';
    const checklists = createMemoryChecklistStore(undefined, () => Promise.resolve(hekVersie));
    await checklists.save('oud', { ...antwoorden('Programma'), token: 'absent' });
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['oud', 'nieuw'], anker: 'nieuw' }],
      beslist: {},
      verhuizingen: [opdracht],
    }));
    /** Het record verandert nét nadat het gelezen is: elk hek van die lezing is verouderd. */
    const origineel = cycli.readMetFence.bind(cycli);
    const wisselend: CyclusStore = {
      ...cycli,
      readMetFence: async (opp) => {
        const uit = await origineel(opp);
        hekVersie = 'versie-nieuw';
        return uit;
      },
    };

    const uit = await voerVerhuizingenUit(wisselend, checklists, 'opp1');

    expect(uit.opnieuw).toBe(true);
    expect((await checklists.read('nieuw')).saved).toBeNull();
    expect((await cycli.read('opp1'))?.verhuizingen).toEqual([opdracht]);
  });

  /**
   * Onleesbare antwoorden als leeg behandelen zou de cyclus een schoon formulier geven en de
   * grendel omzeilen die juist voorkomt dat iemand onzichtbaar werk overschrijft.
   */
  it('blokkeert op een onleesbare bron en houdt de opdracht vast', async () => {
    const cycli = createMemoryCyclusStore();
    const echt = createMemoryChecklistStore(undefined, (key) => cycli.hekToken(key));
    const kapot: ChecklistStore = {
      read: (itemId) =>
        itemId === 'oud'
          ? Promise.resolve({ saved: null, token: 'rommel', unreadable: true })
          : echt.read(itemId),
      save: (itemId, invoer) => echt.save(itemId, invoer),
      clear: (itemId, token) => echt.clear(itemId, token),
    };
    await cycli.update('opp1', () => ({
      groepen: [{ leden: ['oud', 'nieuw'], anker: 'nieuw' }],
      beslist: {},
      verhuizingen: [opdracht],
    }));

    expect(await voerVerhuizingenUit(cycli, kapot, 'opp1')).toEqual({
      geblokkeerd: ['nieuw', 'oud', 'nieuw'],
      opnieuw: false,
    });

    expect((await echt.read('nieuw')).saved).toBeNull();
    expect((await cycli.read('opp1'))?.verhuizingen).toEqual([opdracht]);
  });
});

describe('raaktDezeCyclus', () => {
  /** Twee cycli onder één opdracht: een blokkade bij de ene zet de andere niet op slot. */
  it('geldt alleen voor de cyclus waar de geblokkeerde sessies in zitten', () => {
    const eigen = {
      itemId: 'nieuw',
      cyclus: { sessies: [sessie('oud', true), sessie('nieuw')], anker: 'nieuw' },
    };
    expect(raaktDezeCyclus(['oud'], eigen)).toBe(true);
    expect(raaktDezeCyclus(['x', 'y'], eigen)).toBe(false);
    expect(raaktDezeCyclus(['900'], { itemId: '900', cyclus: null })).toBe(true);
  });
});

describe('moetZoeken', () => {
  it('zoekt bij een training met het cycluslabel', () => {
    expect(moetZoeken('900', true, null)).toBe(true);
  });

  it('zoekt niet bij een gewone training zonder bevestiging', () => {
    expect(moetZoeken('900', false, null)).toBe(false);
    expect(
      moetZoeken('900', false, {
        groepen: [{ leden: ['1', '2'], anker: '1' }],
        beslist: { '1': ['1', '2'] },
        verhuizingen: [],
      })
    ).toBe(false);
  });

  /**
   * Het label kan verdwijnen of ontbreken terwijl de sessie wél bij een bevestigde cyclus hoort.
   * Dan moet ze die cyclus blijven zien, anders krijgt ze stilletjes een eigen checklist.
   */
  it('zoekt voor een sessie die in een bevestigde groep staat, ook zonder label', () => {
    expect(
      moetZoeken('900', false, {
        groepen: [{ leden: ['800', '900'], anker: '800' }],
        beslist: { '800': ['800', '900'] },
        verhuizingen: [],
      })
    ).toBe(true);
  });

  it('zoekt voor een sessie waarover eerder een antwoord is gegeven', () => {
    expect(
      moetZoeken('900', false, {
        groepen: [],
        beslist: { '900': ['800', '900'] },
        verhuizingen: [],
      })
    ).toBe(true);
  });
});
