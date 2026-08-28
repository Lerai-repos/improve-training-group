import { describe, expect, it } from 'vitest';

import { EMPTY_CHECKLIST } from '../blocks';
import { plannedFilenames } from '../generate';
import { runGenerate, UPLOAD_BUDGET_MS, type RunGenerateDeps } from '../run-generate';

import type { SavedChecklist } from '../answers';
import type { BriefingRecorder, BriefingRow, BrieStatus } from '../record';
import type { BriefingTraining } from '../types';
import type { SiteConfig } from '@lib/sharepoint/config';
import type { BriefingStore, UploadedFile } from '@lib/sharepoint/store';

/**
 * De volgorde van beslissingen achter de knop Genereren.
 *
 * Dit is het stuk dat vóór deze test alleen als route-handler bestond en dus onbereikbaar
 * was: een Next-route mag niets exporteren behalve zijn HTTP-methoden, waardoor élke fout in
 * de bedrading — een verkeerd doorgegeven client, een omgedraaide volgorde, een uitkomst die
 * naar de verkeerde statuscode ging — pas bij het lezen aan het licht kwam.
 *
 * Het renderen is hier met opzet ECHT. Dat is precies wat bewijst dat de namen die het plan
 * belooft dezelfde zijn als de namen die er worden neergezet; een gemockte renderfunctie zou
 * die twee weer uit elkaar laten lopen zonder dat iets faalt.
 */

const SITE: SiteConfig = { host: 'h', path: '/sites/x', root: 'General' };

const TRAINING: BriefingTraining = {
  itemId: '900',
  naam: 'Welzijn Ermelo',
  label: 'JE',
  brie: 'Aanmaken',
  opdrachtgever: 'Welzijn Ermelo',
  themas: ['Feedback geven'],
  trainingscodeMc: '',
  themaInhoud: 'Plenaire opening.',
  klanttitel: 'Elkaar aanspreken op gedrag',
  duur: '2',
  datum: '2026-10-09',
  tijden: '14:00-16:00',
  groepsgrootte: '30',
  locatie: 'Raadhuisplein 6, Ermelo',
  voertaal: 'NL',
  klantcontactmoment: 'Telefoon',
  evaluatie: 'Nee',
  ieCode: '',
  accountmanager: null,
  contactpersoon: null,
  trainers: [
    { itemId: '1', naam: 'Frank Paats', telefoon: '', isActeur: false, isCoTrainer: false },
    { itemId: '2', naam: 'Richard Roling', telefoon: '', isActeur: false, isCoTrainer: true },
  ],
  acteuraantal: null,
  opportunityItemId: null,
  achtergrond: 'Iets over de klant.',
  missing: [],
};

const OPGESLAGEN: SavedChecklist = {
  checklist: EMPTY_CHECKLIST,
  actorItemIds: [],
  mondayChallenge: false,
  actorAnswered: true,
};

const MAP = 'General/1. JE/5. Klanten/Welzijn Ermelo';

const BOOM: Record<string, readonly string[]> = {
  General: ['1. JE'],
  'General/1. JE': ['5. Klanten'],
  'General/1. JE/5. Klanten': ['Welzijn Ermelo'],
};

interface Vals {
  readonly store: BriefingStore;
  readonly geupload: readonly string[];
  readonly rijen: readonly BriefingRow[];
  readonly brie: readonly BrieStatus[];
}

function bouw(over: Partial<RunGenerateDeps> & { bestanden?: readonly string[] } = {}): {
  deps: RunGenerateDeps;
  vals: Vals;
} {
  const geupload: string[] = [];
  const rijen: BriefingRow[] = [];
  const brie: BrieStatus[] = [];

  const store: BriefingStore = {
    children: (pad) => Promise.resolve(BOOM[pad] ?? []),
    files: (pad) => Promise.resolve(pad === MAP ? (over.bestanden ?? []) : []),
    find: () => Promise.resolve(null),
    createFolder: () => Promise.resolve(),
    upload: (map, naam): Promise<UploadedFile> => {
      geupload.push(`${map}/${naam}`);
      return Promise.resolve({ id: '01', name: naam, webUrl: `https://sp/${naam}` });
    },
  };

  const recorder: BriefingRecorder = {
    setBrie: (_itemId, status) => {
      brie.push(status);
      return Promise.resolve();
    },
    addRow: (row) => {
      rijen.push(row);
      return Promise.resolve('r1');
    },
  };

  const deps: RunGenerateDeps = {
    readTraining: () => Promise.resolve(TRAINING),
    readChecklist: () => Promise.resolve({ saved: OPGESLAGEN, token: 't1', unreadable: false }),
    store,
    site: SITE,
    buildContext: () =>
      Promise.resolve({
        context: {
          historie: [],
          extraInfo: [],
          mondayChallenge: false,
          reis: new Map(),
          actorItemIds: [],
        },
        notes: [],
      }),
    recorder,
    today: () => '2026-08-26',
    remainingMs: () => 200_000,
    ...over,
  };

  return { deps, vals: { store: deps.store, geupload, rijen, brie } };
}

const VERWACHT = plannedFilenames(TRAINING, EMPTY_CHECKLIST, []);

describe('runGenerate — plannen', () => {
  it('meldt waar de documenten heen gaan en raakt niets aan', async () => {
    const { deps, vals } = bouw();

    const uit = await runGenerate(deps, { itemId: '900', confirmExisting: false });

    expect(uit.kind).toBe('planned');
    if (uit.kind !== 'planned') {
      return;
    }
    expect(uit.plan.folderPath).toBe(MAP);
    expect(uit.plan.filenames).toEqual(VERWACHT);
    expect(uit.plan.conflicts).toEqual([]);
    expect(uit.plan.planToken).not.toBe('');
    expect(vals.geupload).toEqual([]);
    expect(vals.rijen).toEqual([]);
  });

  /** Ligt er al een briefing, dan komt die terug als botsing — en nog steeds zonder schrijven. */
  it('meldt een bestaande briefing als botsing', async () => {
    const { deps, vals } = bouw({ bestanden: [VERWACHT[0]] });

    const uit = await runGenerate(deps, { itemId: '900', confirmExisting: false });

    expect(uit.kind === 'planned' && uit.plan.conflicts).toEqual([VERWACHT[0]]);
    expect(vals.geupload).toEqual([]);
  });

  it('blokkeert zonder eenduidige leadtrainer', async () => {
    const twee = {
      ...TRAINING,
      trainers: TRAINING.trainers.map((t) => ({ ...t, isCoTrainer: false })),
    };
    const { deps, vals } = bouw({ readTraining: () => Promise.resolve(twee) });

    const uit = await runGenerate(deps, { itemId: '900', confirmExisting: false });

    expect(uit.kind).toBe('blocked');
    expect(uit.kind === 'blocked' && uit.issues.join(' ')).toContain('leadkolom');
    expect(vals.geupload).toEqual([]);
  });
});

describe('runGenerate — schrijven', () => {
  /**
   * Het pad dat elke werkdag gelopen wordt en tot nu toe nergens werd nagespeeld: bevestigen,
   * renderen, wegschrijven, vastleggen.
   */
  it('schrijft de documenten weg en legt ze vast', async () => {
    const { deps, vals } = bouw();
    const gepland = await runGenerate(deps, { itemId: '900', confirmExisting: false });
    const token = gepland.kind === 'planned' ? gepland.plan.planToken : '';

    const uit = await runGenerate(deps, {
      itemId: '900',
      confirmExisting: true,
      planToken: token,
    });

    expect(uit.kind).toBe('written');
    if (uit.kind !== 'written') {
      return;
    }
    expect(uit.partial).toBe(false);
    expect(uit.documents.map((d) => d.trainerNaam)).toEqual(['Frank Paats', 'Richard Roling']);
    expect(uit.documents.map((d) => d.role)).toEqual(['lead', 'co']);
    // DE invariant: precies de namen die het plan beloofde, op precies de geplande plek.
    expect(vals.geupload).toEqual(VERWACHT.map((naam) => `${MAP}/${naam}`));
    expect(uit.documents.map((d) => d.file.name)).toEqual([...VERWACHT]);
    // Eén rij per document, met de link erin, en de status die erbij hoort.
    expect(vals.rijen.map((r) => [r.ontvanger, r.role])).toEqual([
      ['Frank Paats', 'lead'],
      ['Richard Roling', 'co'],
    ]);
    expect(vals.rijen.map((r) => r.url)).toEqual(VERWACHT.map((naam) => `https://sp/${naam}`));
    // De fixture heeft lege velden (geen contactpersoon, geen IE-code); die landen als
    // zichtbare «…»-regel, en dát is wat "Begonnen, niet klaar" in ITG's proces betekent.
    expect(uit.documents.some((d) => d.open.length > 0)).toBe(true);
    expect(vals.brie).toEqual(['Begonnen, niet klaar']);
    expect(uit.brie).toBe('Begonnen, niet klaar');
    expect(uit.administratie).toEqual([]);
  });

  /**
   * Uploads zijn stuk voor stuk definitief. Ging het bij document twee mis, dan stáát
   * document één in de klantmap — en die niet vastleggen zou hem wees maken.
   */
  it('legt ook een deelresultaat vast, met de status die daarbij hoort', async () => {
    const { deps, vals } = bouw();
    const store: BriefingStore = {
      ...deps.store,
      upload: (map, naam, bytes) => {
        if (naam === VERWACHT[1]) {
          return Promise.reject(new Error('netwerk weg'));
        }
        return deps.store.upload(map, naam, bytes);
      },
    };
    const eigen = { ...deps, store };
    const gepland = await runGenerate(eigen, { itemId: '900', confirmExisting: false });
    const token = gepland.kind === 'planned' ? gepland.plan.planToken : '';

    const uit = await runGenerate(eigen, {
      itemId: '900',
      confirmExisting: true,
      planToken: token,
    });

    expect(uit.kind).toBe('written');
    if (uit.kind !== 'written') {
      return;
    }
    expect(uit.partial).toBe(true);
    expect(uit.failure?.filename).toBe(VERWACHT[1]);
    // Het document dat het wél haalde staat in Monday, en de status zegt dat het niet af is.
    expect(uit.documents.map((d) => d.trainerNaam)).toEqual(['Frank Paats']);
    expect(vals.rijen).toHaveLength(1);
    expect(vals.brie).toEqual(['Begonnen, niet klaar']);
  });

  /** Een mislukte administratie mag de generatie niet omkiepen: de bestanden stáán er. */
  it('meldt een mislukte administratie zonder de generatie te laten falen', async () => {
    const { deps } = bouw();
    const eigen = {
      ...deps,
      recorder: {
        setBrie: () => Promise.reject(new Error('kolom weg')),
        addRow: () => Promise.reject(new Error('bord weg')),
      },
    };
    const gepland = await runGenerate(eigen, { itemId: '900', confirmExisting: false });
    const token = gepland.kind === 'planned' ? gepland.plan.planToken : '';

    const uit = await runGenerate(eigen, {
      itemId: '900',
      confirmExisting: true,
      planToken: token,
    });

    expect(uit.kind).toBe('written');
    expect(uit.kind === 'written' && uit.administratie.length).toBeGreaterThan(0);
  });
});

describe('runGenerate — als er iets verschuift', () => {
  it('weigert een bevestiging die bij een ander plan hoorde', async () => {
    const { deps, vals } = bouw();

    const uit = await runGenerate(deps, {
      itemId: '900',
      confirmExisting: true,
      planToken: 'iets.anders',
    });

    expect(uit.kind).toBe('changed');
    expect(vals.geupload).toEqual([]);
  });

  /**
   * Tussen bevestigen en schrijven zit het renderen. Wijzigt een collega in die seconden een
   * antwoord, dan hoort er geen document de deur uit te gaan dat bij niemands antwoorden past.
   */
  it('stopt als de checklist tijdens het renderen wijzigt', async () => {
    const { deps, vals } = bouw();
    let ronde = 0;
    const eigen = {
      ...deps,
      readChecklist: () => {
        ronde += 1;
        return Promise.resolve({
          saved: OPGESLAGEN,
          token: ronde > 1 ? 't2' : 't1',
          unreadable: false,
        });
      },
    };
    const gepland = await runGenerate(deps, { itemId: '900', confirmExisting: false });
    const token = gepland.kind === 'planned' ? gepland.plan.planToken : '';

    const uit = await runGenerate(eigen, {
      itemId: '900',
      confirmExisting: true,
      planToken: token,
    });

    expect(uit.kind).toBe('changed');
    expect(uit.kind === 'changed' && uit.plan.changed).toBe('input');
    expect(vals.geupload).toEqual([]);
  });

  /** Ook velden die alleen ín het document staan — de datum verzetten telt. */
  it('stopt als de training tijdens het renderen wijzigt', async () => {
    const { deps, vals } = bouw();
    let ronde = 0;
    const eigen = {
      ...deps,
      readTraining: () => {
        ronde += 1;
        return Promise.resolve(ronde > 1 ? { ...TRAINING, tijden: '09:00-11:00' } : TRAINING);
      },
    };
    const gepland = await runGenerate(deps, { itemId: '900', confirmExisting: false });
    const token = gepland.kind === 'planned' ? gepland.plan.planToken : '';

    const uit = await runGenerate(eigen, {
      itemId: '900',
      confirmExisting: true,
      planToken: token,
    });

    expect(uit.kind).toBe('changed');
    expect(vals.geupload).toEqual([]);
  });

  /**
   * Er is een bestand bijgekomen dat niemand heeft beoordeeld. `writeBriefings` weigert dat,
   * en de adviseur hoort de NIEUWE stand te zien — niet de stand van daarnet.
   */
  it('geeft het verse plan terug als er een botsing bijkomt', async () => {
    const { deps, vals } = bouw();
    let gekeken = 0;
    const store: BriefingStore = {
      ...deps.store,
      files: (pad) => {
        if (pad !== MAP) {
          return Promise.resolve([]);
        }
        gekeken += 1;
        return Promise.resolve(gekeken > 1 ? [VERWACHT[0]] : []);
      },
    };
    const gepland = await runGenerate(deps, { itemId: '900', confirmExisting: false });
    const token = gepland.kind === 'planned' ? gepland.plan.planToken : '';

    const uit = await runGenerate(
      { ...deps, store },
      {
        itemId: '900',
        confirmExisting: true,
        planToken: token,
      }
    );

    expect(uit.kind).toBe('changed');
    if (uit.kind !== 'changed') {
      return;
    }
    expect(uit.plan.changed).toBe('files');
    expect(uit.plan.conflicts).toEqual([VERWACHT[0]]);
    expect(uit.message).toContain('Controleer het opnieuw');
    expect(vals.geupload).toEqual([]);
  });

  /**
   * Renderen kan het budget opeten. Met te weinig tijd over is niet beginnen beter dan
   * halverwege afgekapt worden met bestanden die nergens zijn vastgelegd.
   */
  it('schrijft niets meer als de tijd bijna op is', async () => {
    const { deps, vals } = bouw();
    const gepland = await runGenerate(deps, { itemId: '900', confirmExisting: false });
    const token = gepland.kind === 'planned' ? gepland.plan.planToken : '';

    const uit = await runGenerate(
      { ...deps, remainingMs: () => UPLOAD_BUDGET_MS - 1 },
      { itemId: '900', confirmExisting: true, planToken: token }
    );

    expect(uit.kind).toBe('no_time');
    expect(vals.geupload).toEqual([]);
    expect(vals.rijen).toEqual([]);
  });

  /** Een echte storing hoort door te reizen, niet als "kijk opnieuw" verpakt te worden. */
  it('laat een onbekende fout gewoon door', async () => {
    const { deps } = bouw();
    const store: BriefingStore = {
      ...deps.store,
      files: () => Promise.reject(new Error('SharePoint plat')),
    };

    await expect(
      runGenerate({ ...deps, store }, { itemId: '900', confirmExisting: false })
    ).rejects.toThrow('SharePoint plat');
  });

  it('blokkeert onleesbare antwoorden in plaats van ze als leeg te lezen', async () => {
    const { deps, vals } = bouw({
      readChecklist: () => Promise.resolve({ saved: null, token: 't1', unreadable: true }),
    });

    const uit = await runGenerate(deps, { itemId: '900', confirmExisting: true });

    expect(uit.kind).toBe('blocked');
    expect(vals.geupload).toEqual([]);
  });
});
