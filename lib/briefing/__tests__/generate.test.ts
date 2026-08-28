import { describe, expect, it } from 'vitest';

import { EMPTY_CHECKLIST } from '../blocks';
import { generateBriefings, plannedFilenames } from '../generate';

import type { BriefingTraining } from '../types';

/**
 * Eén training naar één document per ontvanger.
 *
 * De inhoud van de blokken wordt elders getest; hier gaat het om wie er een document krijgt
 * en hoe dat heet — want die naam is waar het botsingsvraagstuk aan hangt.
 */

/**
 * `themas` en `klanttitel` verschillen hier met opzet.
 *
 * Op de meeste trainingen zijn ze gelijk en dekt geen enkele test het verschil af. Juist
 * daarom staan ze hier uit elkaar: de bestandsnaam hoort van `themas` te komen, en een test
 * waarin beide hetzelfde zijn zou de verwisseling niet zien.
 */
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

const CONTEXT = {
  historie: [],
  extraInfo: [],
  mondayChallenge: false,
  reis: new Map(),
  actorItemIds: [],
};

describe('generateBriefings', () => {
  it('maakt één document per ontvanger, met zijn eigen rol', async () => {
    const uit = await generateBriefings(TRAINING, EMPTY_CHECKLIST, CONTEXT);

    expect(uit.kind).toBe('ok');
    const docs = uit.kind === 'ok' ? uit.documents : [];
    expect(docs.map((d) => [d.trainerNaam, d.role])).toEqual([
      ['Frank Paats', 'lead'],
      ['Richard Roling', 'co'],
    ]);
    // Elk document draagt de naam van zijn eigen ontvanger, niet die van de hele ploeg.
    expect(docs[0].filename).toContain('Frank Paats');
    expect(docs[1].filename).toContain('Richard Roling');
    expect(docs[0].bytes.byteLength).toBeGreaterThan(0);
  });

  /**
   * DE invariant waar de bevestiging aan hangt.
   *
   * Plannen zoekt naar bestanden met deze namen; schrijven maakt ze. Wijken ze af, dan
   * vindt de botsingscontrole niets, komt er geen bevestiging, en verschijnt er een `(v2)`
   * die niemand heeft goedgekeurd. Ze horen niet "ongeveer" gelijk te zijn maar identiek.
   */
  it('plant exact de namen die het ook schrijft', async () => {
    const gepland = plannedFilenames(TRAINING, EMPTY_CHECKLIST, []);
    const uit = await generateBriefings(TRAINING, EMPTY_CHECKLIST, CONTEXT);

    expect(uit.kind === 'ok' && uit.documents.map((d) => d.filename)).toEqual(gepland);
  });

  /** De naam komt van `themas`, zoals `composeBriefing` hem ook zet — niet van `klanttitel`. */
  it('gebruikt het thema in de bestandsnaam, niet de klanttitel', () => {
    const [eerste] = plannedFilenames(TRAINING, EMPTY_CHECKLIST, []);

    expect(eerste).toBe('Briefing Welzijn Ermelo - Feedback geven - 09-10-2026 - Frank Paats.docx');
    expect(eerste).not.toContain('Elkaar aanspreken');
  });

  /** Zonder eenduidige lead is er niet één document dat klopt, dus komt er géén. */
  it('weigert een training zonder leadtrainer', async () => {
    const geen = { ...TRAINING, trainers: [] };

    const uit = await generateBriefings(geen, EMPTY_CHECKLIST, CONTEXT);

    expect(uit.kind).toBe('refused');
    expect(plannedFilenames(geen, EMPTY_CHECKLIST, [])).toEqual([]);
  });
});
