import { describe, expect, it } from 'vitest';

import { ORGANISATIE_TOKEN, conceptLines, fillOrganisatie, resolveConceptInhoud } from '../concept';
import { isOpenIssue } from '../open-issues';

const REFLECTIE = `Reflectie: hoe staat het er nu voor met feedback binnen ${ORGANISATIE_TOKEN} en binnen deze groep?`;

describe('conceptLines', () => {
  it('splitst op regels en gooit witruimte weg', () => {
    expect(conceptLines('  Eerste regel.  \n\nTweede regel.\n')).toEqual([
      'Eerste regel.',
      'Tweede regel.',
    ]);
  });

  it('leest ook tekst die uit Word geplakt is, met CRLF', () => {
    expect(conceptLines('Een.\r\nTwee.')).toEqual(['Een.', 'Twee.']);
  });

  it('geeft een lege lijst voor een leeg veld', () => {
    expect(conceptLines('   \n  \n')).toEqual([]);
  });
});

describe('fillOrganisatie', () => {
  it('vult de naam in', () => {
    expect(fillOrganisatie([REFLECTIE], 'Probiblio')).toEqual([
      'Reflectie: hoe staat het er nu voor met feedback binnen Probiblio en binnen deze groep?',
    ]);
  });

  it('vult dezelfde naam ook een tweede keer in dezelfde regel in', () => {
    const line = `${ORGANISATIE_TOKEN} en nog eens ${ORGANISATIE_TOKEN}.`;
    expect(fillOrganisatie([line], 'DAS')).toEqual(['DAS en nog eens DAS.']);
  });

  it('laat regels zonder plaatshouder ongemoeid', () => {
    expect(fillOrganisatie(['Plenaire opening.'], 'Probiblio')).toEqual(['Plenaire opening.']);
  });

  /**
   * Zonder naam mag de bullet niet half afgedrukt worden: "binnen en binnen deze groep?"
   * leest als een slordige zin en niet als een ontbrekend gegeven, en gaat dan ongemerkt
   * mee naar de trainer.
   */
  it('laat de bullet weg en meldt het zichtbaar als de organisatienaam ontbreekt', () => {
    const out = fillOrganisatie(['Plenaire opening.', REFLECTIE], '');
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('Plenaire opening.');
    expect(isOpenIssue(out[1] ?? '')).toBe(true);
  });

  it('meldt niets als er geen enkele bullet een naam nodig heeft', () => {
    const out = fillOrganisatie(['Plenaire opening.'], '   ');
    expect(out).toEqual(['Plenaire opening.']);
  });

  it('behandelt witruimte rond de naam als geen naam', () => {
    const out = fillOrganisatie([REFLECTIE], '   ');
    expect(out.some((line) => line.includes(ORGANISATIE_TOKEN))).toBe(false);
  });
});

describe('resolveConceptInhoud', () => {
  it('gebruikt het skelet van het thema als de adviseur niets heeft getypt', () => {
    expect(
      resolveConceptInhoud({ themaTekst: 'Plenaire opening.\nNext step.', organisatie: 'DAS' })
    ).toEqual(['Plenaire opening.', 'Next step.']);
  });

  it('laat de tekst van de adviseur winnen', () => {
    expect(
      resolveConceptInhoud({
        themaTekst: 'Het skelet.',
        adviseurTekst: 'Eigen versie.',
        organisatie: 'DAS',
      })
    ).toEqual(['Eigen versie.']);
  });

  /**
   * De hele reden dat er alleen wordt opgeslagen als er echt getypt is: anders bevriest
   * elke training een kopie van het skelet en bereikt een verbetering in Monday nooit meer
   * een volgende briefing.
   */
  it('valt terug op het thema als de adviseur het veld leeggemaakt heeft', () => {
    expect(
      resolveConceptInhoud({
        themaTekst: 'Het skelet.',
        adviseurTekst: '   \n  ',
        organisatie: 'DAS',
      })
    ).toEqual(['Het skelet.']);
  });

  it('vult de organisatienaam ook in de tekst van de adviseur in', () => {
    expect(
      resolveConceptInhoud({
        themaTekst: 'Het skelet.',
        adviseurTekst: REFLECTIE,
        organisatie: 'Probiblio',
      })
    ).toEqual([
      'Reflectie: hoe staat het er nu voor met feedback binnen Probiblio en binnen deze groep?',
    ]);
  });

  it('geeft undefined als er nergens tekst is, zodat compose er een «…»-regel van maakt', () => {
    expect(resolveConceptInhoud({ themaTekst: '', organisatie: 'DAS' })).toBeUndefined();
  });
});
