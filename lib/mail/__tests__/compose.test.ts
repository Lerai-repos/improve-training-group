import { describe, expect, it } from 'vitest';

import { composeMails, rapportBestandsnaam } from '../compose';
import { buildMailFacts } from '../facts';

import type { FactsInput } from '../facts';
import type { MailRecipients } from '../recipients';

const input: FactsInput = {
  datum: '2026-09-03',
  klanttitel: 'Building Boksing',
  themaNamen: ['Feedback geven'],
  labelNaam: 'Incompany Trainer',
  rapportterm: 'de training',
  evaluatieformulier: 'www.incompanytrainer.nl/evaluatieformulier',
  contactPersoon: 'Lisa de Vries',
  trainerNamen: ['Jan Bakker'],
  trainerEmails: ['jan@voorbeeld.nl'],
  accountmanager: 'Dirkje',
  ieCode: '251050',
  aantalRespondenten: 12,
  gemiddelde: '7.8',
  vervolgPercentage: 58,
};

const facts = buildMailFacts(input);

const recipients: MailRecipients = {
  klant: 'aanvragen@voorbeeld.nl',
  trainer: 'backoffice@voorbeeld.nl',
  sender: 'automatisering@voorbeeld.nl',
};

const pdf = new Uint8Array([1, 2, 3]);

describe('composeMails', () => {
  it('stuurt de aftersales naar aanvragen en de trainermail naar backoffice', () => {
    const mails = composeMails({ variant: 'met', facts, recipients, rapport: pdf });
    expect(mails.map((m) => m.doel)).toEqual(['klant', 'trainer']);
    expect(mails[0].mail.to).toEqual(['aanvragen@voorbeeld.nl']);
    expect(mails[1].mail.to).toEqual(['backoffice@voorbeeld.nl']);
  });

  it('hangt hetzelfde rapport aan allebei', () => {
    const mails = composeMails({ variant: 'met', facts, recipients, rapport: pdf });
    expect(mails[0].mail.attachment?.bytes).toBe(pdf);
    expect(mails[1].mail.attachment?.bytes).toBe(pdf);
  });

  it('weigert een MET-variant zonder rapport', () => {
    // Beide teksten beloven letterlijk dat de uitslag is bijgevoegd.
    expect(() => composeMails({ variant: 'met', facts, recipients })).toThrow(/bijgevoegd/);
  });

  it('hangt niets aan de ZONDER-varianten', () => {
    const mails = composeMails({ variant: 'zonder', facts, recipients });
    expect(mails).toHaveLength(2);
    expect(mails.every((m) => m.mail.attachment === undefined)).toBe(true);
  });
});

describe('rapportBestandsnaam', () => {
  it('haalt tekens eruit die een ontvanger niet kan opslaan', () => {
    const raar = buildMailFacts({ ...input, klanttitel: 'Bouw / Techniek: dag 2' });
    const naam = rapportBestandsnaam(raar);
    expect(naam).not.toMatch(/[\\/:*?"<>|]/);
    expect(naam).toContain('Bouw Techniek dag 2');
  });

  it('valt terug op een naam als de klanttitel alleen uit die tekens bestond', () => {
    const leeg = buildMailFacts({ ...input, klanttitel: '///' });
    expect(rapportBestandsnaam(leeg)).toContain('training');
  });
});

/**
 * `generateReport` weigert niet bij een ontbrekend logo — het rapport is zonder ook bruikbaar
 * — maar geeft een waarschuwing terug. Verdween die, dan stuurt ITG een ongebrand rapport naar
 * een klant zonder het te weten, en de mail eromheen ziet er volkomen verzorgd uit.
 */
describe('een rapport waarvan de huisstijl niet opgehaald kon worden', () => {
  const warnings = ['logo niet opgehaald', 'voorblad niet opgehaald'];

  it('zet de waarschuwing bovenaan, vóór alles wat ITG moet doen', () => {
    const mails = composeMails({ variant: 'met', facts, recipients, rapport: pdf, warnings });
    for (const m of mails) {
      expect(m.mail.body.startsWith('LET OP:')).toBe(true);
      expect(m.mail.body).toContain('logo niet opgehaald');
      expect(m.mail.body).toContain('voorblad niet opgehaald');
    }
  });

  it('stuurt het rapport gewoon mee, want zonder logo is het nog bruikbaar', () => {
    const mails = composeMails({ variant: 'met', facts, recipients, rapport: pdf, warnings });
    expect(mails.every((m) => m.mail.attachment !== undefined)).toBe(true);
  });

  it('zwijgt als er niets miste', () => {
    const mails = composeMails({ variant: 'met', facts, recipients, rapport: pdf, warnings: [] });
    expect(mails.every((m) => !m.mail.body.includes('LET OP'))).toBe(true);
  });

  it('laat het onderwerp met rust, zodat sorteren blijft werken', () => {
    const zonder = composeMails({ variant: 'met', facts, recipients, rapport: pdf });
    const met = composeMails({ variant: 'met', facts, recipients, rapport: pdf, warnings });
    expect(met[0].mail.subject).toBe(zonder[0].mail.subject);
  });
});
