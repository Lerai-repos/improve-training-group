import { describe, expect, it } from 'vitest';

import { isMarked, parseMarkedUpdate, collectExtraInfo } from '../updates';

/**
 * Alle vaste tekst hieronder is letterlijk overgenomen uit de live borden op 20-Aug-2026
 * (agendabord 2026 en Opportunitybord 1279052045), met namen van klanten en medewerkers
 * eruit. Het zijn de vormen die er écht in staan, niet bedachte randgevallen.
 */

describe('isMarked', () => {
  it('herkent de varianten die de adviseurs echt gebruiken', () => {
    expect(isMarked('Voor in briefing:\nrest')).toBe(true);
    expect(isMarked('Voor in de briefing: \nrest')).toBe(true);
    expect(isMarked('voor in briefing: extra notities over deelnemers')).toBe(true);
    expect(isMarked('Voor in briefing\nzonder dubbele punt')).toBe(true);
  });

  /**
   * Dit staat er echt: een notitie aan zichzelf waarin de zin toevallig voorkomt. Zoeken op
   * "bevat de zin" zou hem meenemen. Op het Opportunitybord bevatten 32 updates de zin en
   * beginnen er 29 mee, dus dit onderscheid haalt er drie valse positieven uit.
   */
  it('negeert de zin midden in een notitie aan zichzelf', () => {
    expect(isMarked('zie planning voor in briefing en voor trainers')).toBe(false);
  });

  it('trapt niet in leeg of niets', () => {
    expect(isMarked(null)).toBe(false);
    expect(isMarked('')).toBe(false);
    expect(isMarked('Gewoon een gewone update.')).toBe(false);
  });
});

describe('parseMarkedUpdate', () => {
  it('haalt de markering eraf en houdt de tekst over', () => {
    expect(
      parseMarkedUpdate('Voor in briefing: aub vragen of trainer meeluncht en terugkoppelen')
    ).toEqual(['aub vragen of trainer meeluncht en terugkoppelen']);
  });

  /**
   * Monday plakt deze regel er zelf onder als de update bij een statuswijziging hoort. Hij
   * is niet van de adviseur en hoort dus niet in de briefing.
   */
  it('gooit Monday’s eigen notitieregel weg', () => {
    const raw =
      'Voor in briefing:\n\nExtra informatie trainer: de training moet gericht zijn op de ' +
      'eindejaarsgesprekken.\n\nNote on Brie - Aanmaken';
    expect(parseMarkedUpdate(raw)).toEqual([
      'Extra informatie trainer: de training moet gericht zijn op de eindejaarsgesprekken.',
    ]);
  });

  it('scheidt alinea’s op lege regels', () => {
    const raw = 'Voor in briefing:\n\n\n19 nov lennart\n\n24 nov\n\nSituatie is geëscaleerd.';
    expect(parseMarkedUpdate(raw)).toEqual(['19 nov lennart', '24 nov', 'Situatie is geëscaleerd.']);
  });

  /**
   * De reden dat losse lines aan elkaar worden geplakt. Monday's editor breekt geplakte
   * tekst midden in een zin af; splitsen op elke regel maakt van `Extra` een losse alinea.
   */
  it('plakt een harde regelafbreking midden in een zin weer aan elkaar', () => {
    const raw = 'Voor in briefing:\n\nExtra\naandacht van trainer om het te laten beklijven.';
    expect(parseMarkedUpdate(raw)).toEqual([
      'Extra aandacht van trainer om het te laten beklijven.',
    ]);
  });

  /** En de reden dat dat plakken niet altijd mag: een opsomming moet opsomming blijven. */
  it('houdt een opsomming uit elkaar', () => {
    const raw =
      'Voor in briefing: \n* Ze hebben geen scherm, wel een whiteboard.\n' +
      '* Was eerst aangevraagd als salestraining\n* De vorige adviseur is uit dienst.';
    expect(parseMarkedUpdate(raw)).toEqual([
      'Ze hebben geen scherm, wel een whiteboard.',
      'Was eerst aangevraagd als salestraining',
      'De vorige adviseur is uit dienst.',
    ]);
  });

  it('herkent ook genummerde opsommingen', () => {
    expect(parseMarkedUpdate('Voor in briefing:\n1. eerste punt\n2. tweede punt')).toEqual([
      'eerste punt',
      'tweede punt',
    ]);
  });

  /** Monday's editor laat zero-width spaces en BOM's achter, midden in echte zinnen. */
  it('verwijdert de onzichtbare tekens van Monday’s editor', () => {
    expect(parseMarkedUpdate('﻿Voor in briefing: ﻿geen papieren flip-over​')).toEqual([
      'geen papieren flip-over',
    ]);
  });

  it('levert niets bij een update zonder markering of zonder inhoud', () => {
    expect(parseMarkedUpdate('Gewoon een update')).toEqual([]);
    expect(parseMarkedUpdate('Voor in briefing:\n\n\nNote on Brie - Aanmaken')).toEqual([]);
    expect(parseMarkedUpdate(null)).toEqual([]);
  });
});

describe('collectExtraInfo', () => {
  it('zet de opmerkingen chronologisch, niet nieuwste eerst', () => {
    const result = collectExtraInfo([
      { textBody: 'Voor in briefing: tweede opmerking', createdAt: '2026-06-26T07:02:46.000Z' },
      { textBody: 'Voor in briefing: eerste opmerking', createdAt: '2026-06-26T07:01:42.000Z' },
    ]);
    expect(result.lines).toEqual(['eerste opmerking', 'tweede opmerking']);
  });

  /**
   * Dezelfde opmerking staat regelmatig zowel op het agenda-item als op de Opportunity.
   * Twee keer afdrukken leest als twee losse aanwijzingen.
   */
  it('ontdubbelt over de twee borden heen, ongeacht witruimte en hoofdletters', () => {
    const result = collectExtraInfo([
      { textBody: 'Voor in briefing: Geen papieren flip-over.', createdAt: '2026-01-01T00:00:00.000Z' },
      { textBody: 'voor in briefing:  geen  papieren flip-over.', createdAt: '2026-01-02T00:00:00.000Z' },
    ]);
    expect(result.lines).toEqual(['Geen papieren flip-over.']);
  });

  it('laat de ongemarkeerde updates buiten de briefing', () => {
    const result = collectExtraInfo([
      { textBody: 'Automatisch gelogde e-mail van de klant', createdAt: '2026-01-01T00:00:00.000Z' },
      { textBody: 'zie planning voor in briefing en voor trainers', createdAt: '2026-01-02T00:00:00.000Z' },
      { textBody: 'Voor in briefing: wel meenemen', createdAt: '2026-01-03T00:00:00.000Z' },
    ]);
    expect(result.lines).toEqual(['wel meenemen']);
  });

  /** Afkapping is geen schemafout, dus geen `throw` — maar het mag ook niet stil blijven. */
  it('geeft de afkapvlag door', () => {
    expect(collectExtraInfo([], { truncated: true }).truncated).toBe(true);
    expect(collectExtraInfo([]).truncated).toBe(false);
  });
});
