import { describe, expect, it } from 'vitest';

import { buildMailFacts, dutchDate } from '../facts';

import type { FactsInput } from '../facts';

const basis: FactsInput = {
  datum: '2026-09-03',
  klanttitel: 'Building Boksing + Conflicthantering',
  themaNamen: ['Feedback geven'],
  labelNaam: 'Incompany Trainer',
  rapportterm: 'de training',
  evaluatieformulier: 'www.incompanytrainer.nl/evaluatieformulier',
  contactPersoon: 'Lisa de Vries, Mark Jansen',
  trainerNamen: ['Jan Bakker'],
  trainerEmails: ['jan@voorbeeld.nl'],
  accountmanager: 'Dirkje',
  ieCode: '251050',
  aantalRespondenten: 12,
  gemiddelde: '7.8',
  vervolgPercentage: 58,
};

describe('dutchDate', () => {
  it('schrijft de maand voluit in het Nederlands', () => {
    expect(dutchDate('2026-09-03')).toBe('3 september 2026');
  });

  it('verschuift niet over een tijdzone', () => {
    // Een datum vlak na middernacht is de klassieke plek waar een dag wegvalt.
    expect(dutchDate('2026-01-01')).toBe('1 januari 2026');
    expect(dutchDate('2026-12-31')).toBe('31 december 2026');
  });

  it('laat onherkenbare invoer staan in plaats van te raden', () => {
    expect(dutchDate('binnenkort')).toBe('binnenkort');
  });
});

describe('buildMailFacts', () => {
  it('gebruikt alleen voornamen, van zowel contact als trainer', () => {
    const facts = buildMailFacts(basis);
    expect(facts.contactNamen).toBe('Lisa en Mark');
    expect(facts.trainerNamen).toBe('Jan');
  });

  it('zet het meervoud om bij twee trainers', () => {
    const facts = buildMailFacts({ ...basis, trainerNamen: ['Jan Bakker', 'Piet Jansen'] });
    expect(facts.trainerNamen).toBe('Jan en Piet');
    expect(facts.trainerWoord).toBe('trainers');
  });

  it('houdt een lege contactkolom leeg in plaats van er iets van te maken', () => {
    expect(buildMailFacts({ ...basis, contactPersoon: '' }).contactNamen).toBe('');
  });

  it('laat een lege trainermail weg in plaats van een lege string door te geven', () => {
    const facts = buildMailFacts({ ...basis, trainerEmails: ['', ' '] });
    expect(facts.trainerEmails).toEqual([]);
  });

  it('laat de datum leeg als er geen datum op het bord staat', () => {
    expect(buildMailFacts({ ...basis, datum: null }).datum).toBe('');
  });
});
