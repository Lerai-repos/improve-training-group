import { describe, expect, it } from 'vitest';

import { GraphError } from '../graph';
import {
  planBriefings,
  UnconfirmedOverwrite,
  UnexpectedDestination,
  UnreviewedConflict,
  writeBriefings,
} from '../publish';

import type { SiteConfig } from '../config';
import type { BriefingStore, UploadedFile } from '../store';

/**
 * De hele weg van bytes naar een bestand in de klantmap.
 *
 * De mappenlogica staat in `resolve.test.ts` en het versienummer in `versions.test.ts`; hier
 * gaat het om wat daaromheen gebeurt — wanneer er een map gemaakt wordt, wanneer we
 * weigeren, en dat een bewerkte briefing nooit onder een generatie verdwijnt.
 */

const SITE: SiteConfig = { host: 'h', path: '/sites/x', root: 'General' };

const BOOM: Record<string, readonly string[]> = {
  General: ['1. JE', '2. TT'],
  'General/1. JE': ['5. Klanten'],
  'General/1. JE/5. Klanten': ['Calduran'],
};

const NAAM = 'Briefing Calduran - Feedback - 09-10-2026 - Frank.docx';
const V2 = 'Briefing Calduran - Feedback - 09-10-2026 - Frank (v2).docx';

function store(
  boom: Record<string, readonly string[]> = BOOM,
  bestanden: Record<string, readonly string[]> = {}
): BriefingStore & { gemaakt: readonly string[]; geupload: readonly string[] } {
  const gemaakt: string[] = [];
  const geupload: string[] = [];
  return {
    gemaakt,
    geupload,
    children: (pad) => Promise.resolve(boom[pad] ?? []),
    files: (pad) => Promise.resolve(bestanden[pad] ?? []),
    find: () => Promise.resolve(null),
    createFolder: (parent, naam) => {
      gemaakt.push(`${parent}/${naam}`);
      return Promise.resolve();
    },
    upload: (map, naam): Promise<UploadedFile> => {
      geupload.push(`${map}/${naam}`);
      return Promise.resolve({ id: '01', name: naam, webUrl: `https://sp/${naam}` });
    },
  };
}

const invoer = { label: 'JE', klant: 'Calduran', jaar: '2026', filenames: [NAAM] };
const doc = { filename: NAAM, bytes: new Uint8Array([1, 2, 3]) };

describe('planBriefings', () => {
  it('meldt een lege map zonder iets aan te raken', async () => {
    const s = store();

    const uit = await planBriefings(s, SITE, invoer);

    expect(uit).toEqual({
      kind: 'ok',
      plan: {
        folderPath: 'General/1. JE/5. Klanten/Calduran',
        folderExists: true,
        conflicts: [],
        related: [],
      },
    });
    expect(s.gemaakt).toEqual([]);
  });

  it('meldt een briefing die er al ligt', async () => {
    const s = store(BOOM, { 'General/1. JE/5. Klanten/Calduran': [NAAM] });

    const uit = await planBriefings(s, SITE, invoer);

    expect(uit.kind === 'ok' && uit.plan.conflicts).toEqual([NAAM]);
  });

  /**
   * De datum is verschoven, dus de bestandsnaam verschilt en er botst niets — terwijl de
   * bewerkte briefing van de oude datum gewoon blijft liggen. Niet blokkeren, wel tonen.
   */
  it('toont oudere versies ook als er niets botst', async () => {
    const s = store(BOOM, { 'General/1. JE/5. Klanten/Calduran': [V2, 'Programma X.docx'] });

    const uit = await planBriefings(s, SITE, invoer);

    expect(uit.kind === 'ok' && uit.plan.conflicts).toEqual([]);
    expect(uit.kind === 'ok' && uit.plan.related).toEqual([V2]);
  });

  it('weigert als de structuur niet klopt, zonder iets aan te raken', async () => {
    const s = store({ General: ['1. JE'] });

    const uit = await planBriefings(s, SITE, invoer);

    expect(uit.kind).toBe('refused');
    expect(s.gemaakt).toEqual([]);
  });
});

describe('writeBriefings', () => {
  it('schrijft in een bestaande klantmap', async () => {
    const s = store();

    const uit = await writeBriefings(s, SITE, invoer, [doc]);

    expect(uit.kind).toBe('written');
    expect(s.gemaakt).toEqual([]);
    expect(s.geupload).toEqual([`General/1. JE/5. Klanten/Calduran/${NAAM}`]);
  });

  it('maakt de klantmap aan als die er nog niet is', async () => {
    const s = store();

    const uit = await writeBriefings(s, SITE, { ...invoer, klant: 'Nieuwe Klant BV' }, [doc]);

    expect(uit.kind).toBe('written');
    expect(s.gemaakt).toEqual(['General/1. JE/5. Klanten/Nieuwe Klant BV']);
  });

  /**
   * HET slot. ITG bewerkt het gegenereerde bestand met de hand; opnieuw genereren mag dat
   * werk niet kunnen wissen zonder dat iemand het bewust heeft gezien.
   */
  it('weigert over een bestaande briefing te schrijven zonder bevestiging', async () => {
    const s = store(BOOM, { 'General/1. JE/5. Klanten/Calduran': [NAAM] });

    await expect(writeBriefings(s, SITE, invoer, [doc])).rejects.toBeInstanceOf(
      UnconfirmedOverwrite
    );
    expect(s.geupload).toEqual([]);
  });

  it('zet er na bevestiging een versie naast, en nooit eroverheen', async () => {
    const s = store(BOOM, { 'General/1. JE/5. Klanten/Calduran': [NAAM] });

    const uit = await writeBriefings(s, SITE, invoer, [doc], {
      confirmedExisting: true,
      confirmedConflicts: [NAAM],
    });

    expect(uit.kind === 'written' && uit.written[0]).toMatchObject({
      requested: NAAM,
      versioned: true,
    });
    expect(s.geupload).toEqual([`General/1. JE/5. Klanten/Calduran/${V2}`]);
  });

  /**
   * Acht documenten uit één training, en de bevestiging geldt voor allemaal tegelijk.
   * Acht losse popups voor één knopdruk is geen ontwerp.
   */
  it('bevestigt één keer voor alle documenten', async () => {
    const co = 'Briefing Calduran - Feedback - 09-10-2026 - Richard.docx';
    const s = store(BOOM, { 'General/1. JE/5. Klanten/Calduran': [NAAM, co] });

    const uit = await writeBriefings(
      s,
      SITE,
      { ...invoer, filenames: [NAAM, co] },
      [doc, { filename: co, bytes: new Uint8Array([4]) }],
      { confirmedExisting: true, confirmedConflicts: [NAAM, co] }
    );

    expect(uit.kind === 'written' && uit.written).toHaveLength(2);
    expect(s.geupload).toEqual([
      `General/1. JE/5. Klanten/Calduran/${V2}`,
      'General/1. JE/5. Klanten/Calduran/Briefing Calduran - Feedback - 09-10-2026 - Richard (v2).docx',
    ]);
  });

  /**
   * Twee documenten met dezelfde gewenste naam in één run — bijvoorbeeld twee trainers die
   * op het bord dezelfde naam hebben staan. Zonder de meegroeiende lijst zou het tweede het
   * eerste overschrijven, bínnen dezelfde generatie.
   */
  it('laat twee documenten in één run niet op elkaar landen', async () => {
    const s = store();

    await writeBriefings(s, SITE, invoer, [doc, { ...doc, bytes: new Uint8Array([9]) }]);

    expect(s.geupload).toEqual([
      `General/1. JE/5. Klanten/Calduran/${NAAM}`,
      `General/1. JE/5. Klanten/Calduran/${V2}`,
    ]);
  });

  /**
   * De laatste plek waar overschrijven nog kon — en waar een ONGEZIENE botsing ontstaat.
   *
   * Twee planners zien allebei een lege map en drukken op Genereren. De eerste zet het
   * bestand neer terwijl de tweede nog aan het renderen is. Er stilletjes een `(v2)` naast
   * zetten zou die tweede een versie bezorgen waar hij nooit ja tegen zei — hij heeft
   * immers "er ligt nog niets" bevestigd, niet "zet er maar een versie naast".
   */
  it('weigert een botsing die tijdens het schrijven ontstond en niemand zag', async () => {
    const s = store();
    let inDeMap: string[] = [];
    const racend: BriefingStore = {
      ...s,
      files: () => Promise.resolve(inDeMap),
      upload: (pad, naam) => {
        // Terwijl wij schrijven blijkt de naam ingenomen door een andere generatie.
        inDeMap = [NAAM];
        return Promise.reject(new GraphError(409, 'nameAlreadyExists', `${pad}/${naam}`));
      },
    };

    await expect(writeBriefings(racend, SITE, invoer, [doc])).rejects.toBeInstanceOf(
      UnreviewedConflict
    );
    expect(s.geupload).toEqual([]);
  });

  /**
   * Dezelfde race, maar dan op een botsing die de adviseur wél heeft gezien.
   *
   * Hij zei "zet er een versie naast", dus als `(v2)` intussen ook bezet raakt is `(v3)`
   * precies wat hij bedoelde. Hier weigeren zou hem laten wachten op een antwoord dat hij
   * al gegeven heeft.
   */
  it('gaat wél hoger versienummeren als de botsing bevestigd was', async () => {
    const map = 'General/1. JE/5. Klanten/Calduran';
    const s = store();
    let inDeMap: string[] = [NAAM];
    let eerste = true;
    const racend: BriefingStore = {
      ...s,
      files: () => Promise.resolve(inDeMap),
      upload: (pad, naam, bytes) => {
        if (eerste) {
          eerste = false;
          inDeMap = [NAAM, V2];
          return Promise.reject(new GraphError(409, 'nameAlreadyExists', `${pad}/${naam}`));
        }
        return s.upload(pad, naam, bytes);
      },
    };

    const uit = await writeBriefings(racend, SITE, invoer, [doc], {
      confirmedExisting: true,
      confirmedConflicts: [NAAM],
    });

    expect(uit.kind === 'written' && uit.written[0].file.name).toContain('(v3)');
    expect(s.geupload).toEqual([
      `${map}/Briefing Calduran - Feedback - 09-10-2026 - Frank (v3).docx`,
    ]);
  });

  /**
   * En de botsing die er bij komt tussen bevestigen en schrijven — het venster waarin het
   * renderen zit, dat seconden duurt.
   */
  it('weigert een botsing die pas bij het herplannen opdook', async () => {
    const co = 'Briefing Calduran - Feedback - 09-10-2026 - Richard.docx';
    // Bevestigd is alléén NAAM; `co` is er intussen bij gekomen.
    const s = store(BOOM, { 'General/1. JE/5. Klanten/Calduran': [NAAM, co] });

    await expect(
      writeBriefings(
        s,
        SITE,
        { ...invoer, filenames: [NAAM, co] },
        [doc, { filename: co, bytes: new Uint8Array([4]) }],
        { confirmedExisting: true, confirmedConflicts: [NAAM] }
      )
    ).rejects.toBeInstanceOf(UnreviewedConflict);
    expect(s.geupload).toEqual([]);
  });

  /**
   * Blijft het botsen, dan stoppen we — en schrijven zeker niet alsnog eroverheen.
   *
   * De map leest hier steeds als leeg terwijl elke upload botst: een onmogelijke combinatie
   * die precies daarom geschikt is, want hij dwingt de lus tot het einde zonder dat de
   * bevestigingspoort er iets van meekrijgt.
   */
  it('geeft het op in plaats van te blijven proberen', async () => {
    const s = store();
    const altijdBezet: BriefingStore = {
      ...s,
      files: () => Promise.resolve([]),
      upload: (pad, naam) =>
        Promise.reject(new GraphError(409, 'nameAlreadyExists', `${pad}/${naam}`)),
    };

    await expect(writeBriefings(altijdBezet, SITE, invoer, [doc])).rejects.toThrow(
      /geen vrije naam/
    );
  });

  /**
   * Uploads zijn stuk voor stuk definitief.
   *
   * Faalt document twee, dan stáát document één in de klantmap. Een kale fout teruggeven zou
   * dat bestand wees maken: nergens vastgelegd, en bij een nieuwe poging telt het mee als
   * bestaande briefing waar dan een versie naast komt.
   */
  it('geeft terug wat er wél is weggeschreven als de rest faalt', async () => {
    const co = 'Briefing Calduran - Feedback - 09-10-2026 - Richard.docx';
    const s = store();
    let geteld = 0;
    const halveMislukking: BriefingStore = {
      ...s,
      upload: (pad, naam, bytes) => {
        geteld += 1;
        return geteld === 1
          ? s.upload(pad, naam, bytes)
          : Promise.reject(new Error('Graph gaf 500'));
      },
    };

    const uit = await writeBriefings(halveMislukking, SITE, { ...invoer, filenames: [NAAM, co] }, [
      doc,
      { filename: co, bytes: new Uint8Array([4]) },
    ]);

    expect(uit.kind).toBe('partial');
    expect(uit.kind === 'partial' && uit.written).toHaveLength(1);
    expect(uit.kind === 'partial' && uit.written[0].file.name).toBe(NAAM);
    expect(uit.kind === 'partial' && uit.failure).toMatchObject({ filename: co });
  });

  /** Is er nog niets weggeschreven, dan is er ook niets te melden: gewoon de fout. */
  it('werpt gewoon als het bij het eerste document al misgaat', async () => {
    const s = store();
    const stuk: BriefingStore = {
      ...s,
      upload: () => Promise.reject(new Error('Graph gaf 500')),
    };

    await expect(writeBriefings(stuk, SITE, invoer, [doc])).rejects.toThrow('Graph gaf 500');
  });

  /**
   * De bestemming wordt bij het schrijven opnieuw opgelost, en daartussen zit het renderen.
   *
   * Hernoemt ITG in die tijd een labelmap, of verschijnt er een jaarmap, dan wijst dezelfde
   * training ineens naar een ándere map — en zou de briefing landen op een plek die niemand
   * heeft goedgekeurd.
   */
  it('weigert te schrijven in een andere map dan de bevestigde', async () => {
    const s = store();

    await expect(
      writeBriefings(s, SITE, invoer, [doc], {
        confirmedExisting: true,
        confirmedConflicts: [],
        confirmedFolderPath: 'General/1. JE/5. Klanten/2026/Calduran',
      })
    ).rejects.toBeInstanceOf(UnexpectedDestination);
    expect(s.geupload).toEqual([]);
    expect(s.gemaakt).toEqual([]);
  });

  it('schrijft gewoon als de bevestigde map nog klopt', async () => {
    const s = store();

    const uit = await writeBriefings(s, SITE, invoer, [doc], {
      confirmedFolderPath: 'General/1. JE/5. Klanten/Calduran',
    });

    expect(uit.kind).toBe('written');
  });

  /**
   * Een PUT kan zijn vastgelegd terwijl het antwoord verloren gaat — een afgebroken
   * verbinding, of onze eigen afbreking vlak voor de functietimeout. Meteen doorwerpen zou
   * dat bestand tot wees maken: het staat in de klantmap, maar niet in `written` en dus niet
   * in Monday, en de volgende poging telt het mee als bestaande briefing.
   */
  it('herkent een upload die tóch is aangekomen na een verbroken verbinding', async () => {
    const s = store();
    const zoekgeraakt: BriefingStore = {
      ...s,
      upload: () => Promise.reject(new Error('socket hang up')),
      // Dezelfde omvang als `doc.bytes`: dit ís ons bestand.
      find: (map, naam) =>
        Promise.resolve({ id: '01', name: naam, webUrl: `https://sp/${naam}`, size: 3 }),
    };

    const uit = await writeBriefings(zoekgeraakt, SITE, invoer, [doc]);

    expect(uit.kind).toBe('written');
    expect(uit.kind === 'written' && uit.written[0].file.name).toBe(NAAM);
  });

  /**
   * Een bestand van een ándere generatie op dezelfde naam. De omvang klopt niet, dus het is
   * niet het onze — en dan is doorwerpen veiliger dan andermans bestand claimen en er een
   * rij in Monday bij zetten die naar hún document wijst.
   */
  it('claimt niet het bestand van een ander bij een verbroken verbinding', async () => {
    const s = store();
    const vreemd: BriefingStore = {
      ...s,
      upload: () => Promise.reject(new Error('socket hang up')),
      find: (map, naam) =>
        Promise.resolve({ id: '99', name: naam, webUrl: `https://sp/${naam}`, size: 9999 }),
    };

    await expect(writeBriefings(vreemd, SITE, invoer, [doc])).rejects.toThrow('socket hang up');
  });

  /**
   * Een 500 van Graph zegt dat er iets misging op hún kant — niet dát er niets is gebeurd.
   * SharePoint kan de PUT allang hebben vastgelegd, en dan is doorwerpen precies hoe een
   * bestand wees wordt.
   */
  it('herstelt ook na een 5xx van Graph', async () => {
    const s = store();
    const stuk: BriefingStore = {
      ...s,
      upload: (pad, naam) =>
        Promise.reject(new GraphError(503, 'serviceNotAvailable', `${pad}/${naam}`)),
      find: (map, naam) =>
        Promise.resolve({ id: '01', name: naam, webUrl: `https://sp/${naam}`, size: 3 }),
    };

    const uit = await writeBriefings(stuk, SITE, invoer, [doc]);

    expect(uit.kind).toBe('written');
  });

  /** Een 4xx is wél een duidelijk antwoord: er is niets vastgelegd, dus niets te herstellen. */
  it('herstelt niet na een 4xx, want dan staat er niets', async () => {
    const s = store();
    let gezocht = 0;
    const geweigerd: BriefingStore = {
      ...s,
      upload: (pad, naam) => Promise.reject(new GraphError(403, 'accessDenied', `${pad}/${naam}`)),
      find: (map, naam) => {
        gezocht += 1;
        return Promise.resolve({ id: '01', name: naam, webUrl: 'x', size: 3 });
      },
    };

    await expect(writeBriefings(geweigerd, SITE, invoer, [doc])).rejects.toThrow(/403/);
    expect(gezocht).toBe(0);
  });

  /** Staat hij er écht niet, dan is het gewoon een mislukking. */
  it('werpt alsnog als het bestand er niet blijkt te staan', async () => {
    const s = store();
    const echtStuk: BriefingStore = {
      ...s,
      upload: () => Promise.reject(new Error('socket hang up')),
      find: () => Promise.resolve(null),
    };

    await expect(writeBriefings(echtStuk, SITE, invoer, [doc])).rejects.toThrow('socket hang up');
  });

  it('weigert een label dat ITG niet heeft, zonder te schrijven', async () => {
    const s = store();

    const uit = await writeBriefings(s, SITE, { ...invoer, label: 'SST' }, [doc]);

    expect(uit.kind).toBe('refused');
    expect(s.geupload).toEqual([]);
  });

  /**
   * Acceptatiecriterium 9 uit `06-briefing.md`, maar dan voor de MAP.
   *
   * Een schuine streep zou geen map `Gemeente Ede - Wageningen` opleveren maar een map
   * `Gemeente Ede` met `Wageningen` erin, en de briefing verdwijnt een niveau dieper dan
   * iemand verwacht.
   */
  it('saneert een klantnaam met een schuine streep tot één map', async () => {
    const s = store({
      General: ['1. JE'],
      'General/1. JE': ['5. Klanten'],
      'General/1. JE/5. Klanten': [],
    });

    await writeBriefings(s, SITE, { ...invoer, klant: 'Gemeente Ede / Wageningen' }, [doc]);

    expect(s.gemaakt).toEqual(['General/1. JE/5. Klanten/Gemeente Ede - Wageningen']);
    expect(s.geupload[0]).toContain('/Gemeente Ede - Wageningen/Briefing');
  });

  it('herkent de bestaande map van zo’n klant zonder een tweede te maken', async () => {
    const s = store({
      General: ['1. JE'],
      'General/1. JE': ['5. Klanten'],
      'General/1. JE/5. Klanten': ['Gemeente Ede - Wageningen'],
    });

    await writeBriefings(s, SITE, { ...invoer, klant: 'Gemeente Ede / Wageningen' }, [doc]);

    expect(s.gemaakt).toEqual([]);
  });
});
