import { describe, expect, it } from 'vitest';

import { alreadyExists, nextVersionName, relatedBriefings } from '../versions';

/**
 * Nooit overschrijven, altijd ernaast.
 *
 * Het bestand dat wij schrijven is het bestand dat ITG met de hand bewerkt — daar zetten ze
 * hun extra tekst en plaatjes in. Opnieuw genereren mag dat werk dus niet kunnen wissen.
 */

const BASIS = 'Briefing Calduran - Feedback - 09-10-2026 - Frank.docx';
const V2 = 'Briefing Calduran - Feedback - 09-10-2026 - Frank (v2).docx';
const V3 = 'Briefing Calduran - Feedback - 09-10-2026 - Frank (v3).docx';

describe('nextVersionName', () => {
  it('gebruikt de gewone naam als er nog niets staat', () => {
    expect(nextVersionName(BASIS, [])).toBe(BASIS);
    expect(nextVersionName(BASIS, ['Programma Calduran.docx'])).toBe(BASIS);
  });

  it('zet er een versie naast als de naam bezet is', () => {
    expect(nextVersionName(BASIS, [BASIS])).toBe(V2);
    expect(nextVersionName(BASIS, [BASIS, V2])).toBe(V3);
  });

  /**
   * Een gat niet opvullen. Zou een verwijderde `(v2)` opnieuw gebruikt worden, dan staat er
   * een verse briefing tussen twee oudere en zegt de volgorde in de map niets meer.
   */
  it('telt door vanaf de hoogste, niet vanaf het eerste gaatje', () => {
    expect(nextVersionName(BASIS, [BASIS, V3])).toBe(
      'Briefing Calduran - Feedback - 09-10-2026 - Frank (v4).docx'
    );
  });

  /** SharePoint kijkt niet naar hoofdletters, dus een botsing is een botsing. */
  it('ziet een naam die alleen in hoofdletters verschilt als bezet', () => {
    expect(nextVersionName(BASIS, [BASIS.toUpperCase()])).toBe(V2);
  });

  /** Een andere trainer of datum is een ander bestand, geen nieuwe versie. */
  it('bemoeit zich niet met een briefing van een andere sessie', () => {
    const ander = 'Briefing Calduran - Feedback - 09-10-2026 - Richard.docx';
    expect(nextVersionName(BASIS, [ander])).toBe(BASIS);
  });
});

describe('alreadyExists', () => {
  it('bepaalt of er bevestigd moet worden', () => {
    expect(alreadyExists(BASIS, [])).toBe(false);
    expect(alreadyExists(BASIS, [V2])).toBe(false);
    expect(alreadyExists(BASIS, [BASIS])).toBe(true);
    expect(alreadyExists(BASIS, [BASIS.toLowerCase()])).toBe(true);
  });
});

describe('relatedBriefings', () => {
  it('vindt elke versie van dezelfde briefing', () => {
    expect(relatedBriefings(BASIS, [BASIS, V2, 'Programma X.docx'])).toEqual([BASIS, V2]);
  });

  it('laat de briefing van een andere trainer met rust', () => {
    const ander = 'Briefing Calduran - Feedback - 09-10-2026 - Richard.docx';
    expect(relatedBriefings(BASIS, [ander])).toEqual([]);
  });

  /**
   * HET geval waarvoor dit bestaat, en waar het eerst blind voor was.
   *
   * De sessie is verschoven, dus de bestandsnaam bevat een andere datum en botst nergens
   * mee — terwijl de door ITG bewerkte briefing van de oude datum gewoon blijft liggen. Werd
   * er op de volledige naam vergeleken, inclusief datum, dan kón dit nooit gevonden worden
   * en beloofde het contract iets wat de code niet deed.
   */
  it('vindt de briefing van vóór het verzetten van de sessie', () => {
    const oud = 'Briefing Calduran - Feedback - 09-10-2026 - Frank.docx';
    const nieuw = 'Briefing Calduran - Feedback - 10-10-2026 - Frank.docx';

    expect(relatedBriefings(nieuw, [oud])).toEqual([oud]);
  });

  it('vindt ook een oudere versie van de verzette sessie', () => {
    const oudV2 = 'Briefing Calduran - Feedback - 09-10-2026 - Frank (v2).docx';
    const nieuw = 'Briefing Calduran - Feedback - 10-10-2026 - Frank.docx';

    expect(relatedBriefings(nieuw, [oudV2])).toEqual([oudV2]);
  });

  /** Datum weglaten mag klant, thema en trainer níet op één hoop gooien. */
  it('haalt een andere trainer of thema nog steeds niet binnen', () => {
    const nieuw = 'Briefing Calduran - Feedback - 10-10-2026 - Frank.docx';

    expect(
      relatedBriefings(nieuw, [
        'Briefing Calduran - Feedback - 09-10-2026 - Richard.docx',
        'Briefing Calduran - Time management - 09-10-2026 - Frank.docx',
        'Briefing Aventus - Feedback - 09-10-2026 - Frank.docx',
      ])
    ).toEqual([]);
  });
});
