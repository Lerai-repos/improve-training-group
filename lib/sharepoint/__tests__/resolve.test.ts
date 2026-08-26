import { describe, expect, it } from 'vitest';

import { normaliseFolderName, normaliseNumbered, sanitiseItemName, yearOfDate } from '../paths';
import { resolveBriefingLocation, type FolderLister } from '../resolve';

/**
 * Waar een briefing landt, en wanneer we weigeren.
 *
 * De mappenamen hieronder zijn overgenomen van ITG's eigen site, inclusief de
 * inconsistenties: `1. JE` naast `10. ST`, `5. Klanten` onder JE maar `05. klanten` onder
 * TT, en jaarmappen die onder het ene label wél en onder het andere niet bestaan.
 */

/** Een boom van pad → mappen eronder. Alles wat er niet in staat, bestaat niet. */
function lister(boom: Record<string, readonly string[]>): FolderLister {
  return { children: (pad) => Promise.resolve(boom[pad] ?? []) };
}

const LABELS = ['0. ITG', '1. JE', '2. TT', '3. WJ', '10. ST', '14. Persoonlijke mappen'];

/** JE: klanten los onder Klanten, alleen oude jaren gearchiveerd. */
const JE = {
  General: LABELS,
  'General/1. JE': ['5. Klanten', '1. Offertes'],
  'General/1. JE/5. Klanten': ['Calduran', 'Antonius Ziekenhuis Nieuwegein', '2025', '2024'],
};

/** TT: álles in jaarmappen, en de klantenmap heet anders. */
const TT = {
  General: LABELS,
  'General/2. TT': ['05. klanten'],
  'General/2. TT/05. klanten': ['2026', '2025', '2024'],
  'General/2. TT/05. klanten/2026': ['Aventus'],
};

const invoer = {
  root: 'General',
  label: 'JE',
  klant: 'Calduran',
  jaar: '2026',
};

describe('resolveBriefingLocation', () => {
  it('vindt een bestaande klantmap los onder Klanten', async () => {
    const uit = await resolveBriefingLocation(lister(JE), invoer);

    expect(uit).toEqual({
      kind: 'ok',
      location: { path: 'General/1. JE/5. Klanten/Calduran', exists: true },
    });
  });

  /** `05. klanten` versus `5. Klanten`: zowel het nummer als de schrijfwijze verschilt. */
  it('vindt de klantenmap ook als hij anders geschreven is', async () => {
    const uit = await resolveBriefingLocation(lister(TT), {
      ...invoer,
      label: 'TT',
      klant: 'Aventus',
    });

    expect(uit).toEqual({
      kind: 'ok',
      location: { path: 'General/2. TT/05. klanten/2026/Aventus', exists: true },
    });
  });

  /** Het nummer voor het label is de willekeurige helft en mag nooit de sleutel zijn. */
  it('matcht het label op de tekst, niet op het nummer', async () => {
    const uit = await resolveBriefingLocation(lister({ ...JE, General: ['99. JE'] }), {
      ...invoer,
      // Zelfde boom, ander nummer: alleen de labelmap zelf verandert van naam.
      root: 'General',
    });

    expect(uit.kind).toBe('refused');
    // `99. JE` bestaat wel, maar de mappen eronder in deze boom niet — dus faalt het op het
    // volgende niveau, en NIET op het label. Dat is precies wat het nummer irrelevant maakt.
    expect(uit.kind === 'refused' && uit.reason).toContain('Klanten');
  });

  describe('de jaarmap', () => {
    it('gebruikt hem als hij bestaat', async () => {
      const boom = {
        ...JE,
        'General/1. JE/5. Klanten': ['2026', '2025'],
        'General/1. JE/5. Klanten/2026': ['Calduran'],
      };

      const uit = await resolveBriefingLocation(lister(boom), invoer);

      expect(uit).toEqual({
        kind: 'ok',
        location: { path: 'General/1. JE/5. Klanten/2026/Calduran', exists: true },
      });
    });

    /** Geen jaarmap is geen fout — dat is JE vandaag, en het moet gewoon werken. */
    it('slaat hem over als hij er niet is', async () => {
      const uit = await resolveBriefingLocation(lister(JE), invoer);
      expect(uit.kind === 'ok' && uit.location.path).toContain('5. Klanten/Calduran');
    });

    /**
     * Het jaar van de SESSIE, niet van vandaag. Een training in januari 2027 die we in 2026
     * genereren hoort bij 2027, en hun eigen indeling zegt dat ook.
     */
    it('kiest het jaar van de training', async () => {
      const boom = {
        ...JE,
        'General/1. JE/5. Klanten': ['2026', '2027'],
        'General/1. JE/5. Klanten/2027': ['Calduran'],
      };

      const uit = await resolveBriefingLocation(lister(boom), { ...invoer, jaar: '2027' });

      expect(uit.kind === 'ok' && uit.location.path).toBe('General/1. JE/5. Klanten/2027/Calduran');
    });

    /**
     * Een half opgeruimd label: de klant staat nog los, maar er is al een jaarmap.
     *
     * Blind in de jaarmap aanmaken zou een tweede map voor dezelfde klant opleveren, naast
     * degene met de hele historie erin — en dat is de map waar iedereen naartoe linkt.
     */
    it('gebruikt de bestaande klantmap in plaats van er een in de jaarmap bij te maken', async () => {
      const boom = {
        ...JE,
        'General/1. JE/5. Klanten': ['Calduran', '2026'],
        'General/1. JE/5. Klanten/2026': [],
      };

      const uit = await resolveBriefingLocation(lister(boom), invoer);

      expect(uit).toEqual({
        kind: 'ok',
        location: { path: 'General/1. JE/5. Klanten/Calduran', exists: true },
      });
    });

    /** Staat hij in beide, dan wint de jaarmap: dat is de indeling waar ITG naartoe wil. */
    it('kiest de jaarmap als de klant op allebei de plekken staat', async () => {
      const boom = {
        ...JE,
        'General/1. JE/5. Klanten': ['Calduran', '2026'],
        'General/1. JE/5. Klanten/2026': ['Calduran'],
      };

      const uit = await resolveBriefingLocation(lister(boom), invoer);

      expect(uit.kind === 'ok' && uit.location.path).toBe('General/1. JE/5. Klanten/2026/Calduran');
    });

    /** Zonder datum is er geen jaar, en dan is de wortel de enige plek die klopt. */
    it('valt terug op Klanten als de training geen datum heeft', async () => {
      const boom = { ...JE, 'General/1. JE/5. Klanten': ['2026'] };

      const uit = await resolveBriefingLocation(lister(boom), { ...invoer, jaar: null });

      expect(uit).toEqual({
        kind: 'ok',
        location: { path: 'General/1. JE/5. Klanten/Calduran', exists: false },
      });
    });
  });

  describe('een klant die er nog niet is', () => {
    it('maakt de map aan, met Monday’s eigen schrijfwijze', async () => {
      const uit = await resolveBriefingLocation(lister(JE), {
        ...invoer,
        klant: 'Nieuwe Klant BV',
      });

      expect(uit).toEqual({
        kind: 'ok',
        location: { path: 'General/1. JE/5. Klanten/Nieuwe Klant BV', exists: false },
      });
    });

    it('maakt hem in de jaarmap als die er is', async () => {
      const uit = await resolveBriefingLocation(lister(TT), {
        ...invoer,
        label: 'TT',
        klant: 'Nieuwe Klant BV',
      });

      expect(uit).toEqual({
        kind: 'ok',
        location: { path: 'General/2. TT/05. klanten/2026/Nieuwe Klant BV', exists: false },
      });
    });

    /** Losse leestekens en hoofdletters maken geen nieuwe klant. */
    it('herkent een bestaande map ondanks schrijfwijze', async () => {
      const boom = {
        ...JE,
        'General/1. JE/5. Klanten': ['ActiefWerkt!', 'BPD Europe B.V.'],
      };

      const gevonden = await resolveBriefingLocation(lister(boom), {
        ...invoer,
        klant: 'Actiefwerkt',
      });
      expect(gevonden.kind === 'ok' && gevonden.location).toEqual({
        path: 'General/1. JE/5. Klanten/ActiefWerkt!',
        exists: true,
      });

      const bv = await resolveBriefingLocation(lister(boom), { ...invoer, klant: 'BPD Europe BV' });
      expect(bv.kind === 'ok' && bv.location.exists).toBe(true);
    });

    /**
     * DE reden dat er nooit op afstand vergeleken wordt.
     *
     * Deze twee staan echt naast elkaar op hun lijst. Elke drempel die los genoeg is om
     * typefouten op te vangen, gooit deze twee ziekenhuizen vroeg of laat op één hoop — en
     * een briefing in de map van de verkeerde klant ziet niemand.
     */
    it('houdt twee ziekenhuizen met bijna dezelfde naam uit elkaar', async () => {
      const boom = {
        ...JE,
        'General/1. JE/5. Klanten': [
          'Antoni van Leeuwenhoek ziekenhuis',
          'Antonius Ziekenhuis Nieuwegein',
        ],
      };

      const uit = await resolveBriefingLocation(lister(boom), {
        ...invoer,
        klant: 'Antonius Ziekenhuis Nieuwegein',
      });

      expect(uit.kind === 'ok' && uit.location).toEqual({
        path: 'General/1. JE/5. Klanten/Antonius Ziekenhuis Nieuwegein',
        exists: true,
      });
    });
  });

  describe('weigeren in plaats van verzinnen', () => {
    /**
     * Een label- of klantenmap draagt een nummer dat bij ITG's indeling hoort. Zelf een
     * `16. XYZ` aanmaken levert een map op die eruitziet alsof hij van hen is.
     */
    it('maakt geen labelmap aan die er niet is', async () => {
      const uit = await resolveBriefingLocation(lister(JE), { ...invoer, label: 'SST' });

      expect(uit.kind).toBe('refused');
      expect(uit.kind === 'refused' && uit.reason).toContain('SST');
      expect(uit.kind === 'refused' && uit.reason).toContain('maak deze map niet zelf aan');
    });

    it('maakt geen klantenmap aan die er niet is', async () => {
      const uit = await resolveBriefingLocation(
        lister({ General: LABELS, 'General/1. JE': ['1. Offertes'] }),
        invoer
      );

      expect(uit.kind).toBe('refused');
      expect(uit.kind === 'refused' && uit.reason).toContain('Klanten');
    });

    it('gokt niet tussen twee mappen die na normalisatie hetzelfde heten', async () => {
      const boom = {
        ...JE,
        'General/1. JE/5. Klanten': ['Calduran', 'CALDURAN'],
      };

      const uit = await resolveBriefingLocation(lister(boom), invoer);

      expect(uit.kind).toBe('refused');
      expect(uit.kind === 'refused' && uit.reason).toContain('gok hier niet');
    });

    it('gokt ook niet tussen twee labelmappen met hetzelfde label', async () => {
      const uit = await resolveBriefingLocation(
        lister({ ...JE, General: ['1. JE', '7. JE'] }),
        invoer
      );

      expect(uit.kind).toBe('refused');
      expect(uit.kind === 'refused' && uit.reason).toContain('1. JE, 7. JE');
    });
  });
});

describe('normalisatie', () => {
  it('haalt het nummer eraf, en alleen daar waar er een hoort', () => {
    expect(normaliseNumbered('05. klanten')).toBe('klanten');
    expect(normaliseNumbered('5. Klanten')).toBe('klanten');
    expect(normaliseNumbered('10. ST')).toBe('st');
    // Een klantnaam die met een cijfer begint mag niet onthoofd worden.
    expect(normaliseFolderName('12Build Sales BV')).toBe('12build sales bv');
  });

  it('vouwt accenten, leestekens en spaties samen', () => {
    expect(normaliseFolderName('Café  Zürich')).toBe('cafe zurich');
    expect(normaliseFolderName('B.V. Iets')).toBe('bv iets');
    expect(normaliseFolderName('  Dubbele   spaties ')).toBe('dubbele spaties');
  });

  /**
   * SharePoint weigert een naam die op een punt eindigt of met een tilde begint, en `B.V.`
   * is de gewoonste Nederlandse achtervoeging die er is. De allereerste map voor zo'n nieuwe
   * klant zou dus meteen mislukken.
   */
  it('haalt de randen weg die SharePoint verbiedt', () => {
    expect(sanitiseItemName('Nieuwe Klant B.V.')).toBe('Nieuwe Klant B.V');
    expect(sanitiseItemName('~Nieuwe Klant')).toBe('Nieuwe Klant');
    expect(sanitiseItemName('Klant...')).toBe('Klant');
    // En de punt binnenín blijft gewoon staan; die mag.
    expect(sanitiseItemName('B.V. Iets')).toBe('B.V. Iets');
  });

  it('leest het jaar uit een datum, en weigert de rest', () => {
    expect(yearOfDate('2026-10-09')).toBe('2026');
    expect(yearOfDate('09-10-2026')).toBeNull();
    expect(yearOfDate('')).toBeNull();
    expect(yearOfDate(null)).toBeNull();
  });
});
