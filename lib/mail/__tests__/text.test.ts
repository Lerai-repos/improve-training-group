import { describe, expect, it } from 'vitest';

import { buildMailFacts } from '../facts';
import { aftersalesMet, aftersalesZonder, trainerMet, trainerZonder } from '../text';

import type { FactsInput } from '../facts';

const input: FactsInput = {
  datum: '2026-09-03',
  klanttitel: 'Building Boksing',
  klant: 'Gemeente Emmen',
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

describe('aftersalesMet', () => {
  const { body } = aftersalesMet(facts);

  it('vult de gele velden uit het V2-document', () => {
    expect(body).toContain('3 september 2026');
    expect(body).toContain('de sessie over Feedback geven');
    expect(body).toContain('door 12 mensen ingevuld');
    expect(body).toContain('gemiddelde van een 7.8');
    expect(body).toContain('58% van de respondenten');
    expect(body).toContain('www.incompanytrainer.nl/evaluatieformulier');
  });

  it('laat de rode velden staan als opdracht, niet als lege zin', () => {
    expect(body).toContain('[WAT DE TRAINER OPVIEL');
    expect(body).toContain('[KIES VARIANT A OF B');
  });

  it('belooft de bijlage, want die zit er ook bij', () => {
    expect(body).toContain('bijgevoegd');
  });
});

describe('de cijferzinnen vallen weg als er geen cijfer is', () => {
  it('noemt geen gemiddelde als niemand een cijfer gaf', () => {
    const zonderCijfer = buildMailFacts({ ...input, gemiddelde: null });
    const { body } = aftersalesMet(zonderCijfer);
    expect(body).toContain('door 12 mensen ingevuld');
    expect(body).not.toContain('gemiddelde van een');
  });

  it('noemt geen percentage als niemand de vervolgvraag beantwoordde', () => {
    const zonderVervolg = buildMailFacts({ ...input, vervolgPercentage: null });
    expect(aftersalesMet(zonderVervolg).body).not.toContain('% van de respondenten');
  });

  it('zegt niet "0%" als niemand antwoordde', () => {
    // Nul procent is een bewering; geen antwoorden is er geen.
    const zonderVervolg = buildMailFacts({ ...input, vervolgPercentage: null });
    expect(aftersalesMet(zonderVervolg).body).not.toContain('0%');
  });
});

describe('een label zonder evaluatieformulier', () => {
  it('meldt dat de URL ontbreekt in plaats van een halve zin te sturen', () => {
    const zonderUrl = buildMailFacts({ ...input, evaluatieformulier: '' });
    const { body } = aftersalesMet(zonderUrl);
    expect(body).toContain('EVALUATIEFORMULIER VAN DIT LABEL ONTBREEKT');
    expect(body).not.toContain('formulier hier: \n');
  });
});

describe('aftersalesZonder', () => {
  const { body, subject } = aftersalesZonder(facts);

  it('noemt de IE-code, want daar draait het nasturen om', () => {
    expect(body).toContain('251050');
  });

  it('geeft de directe formulierlinks mee', () => {
    expect(body).toContain('https://forms.gle/P9CBnDgVhbz8iRZp9');
    expect(body).toContain('https://forms.gle/nCgrK9tdiw792MJr9');
  });

  it('belooft geen bijlage die er niet is', () => {
    expect(body).not.toContain('bijgevoegd');
  });

  it('is aan het onderwerp te herkennen in een volle postbus', () => {
    expect(subject).toContain('GEEN evaluaties');
  });
});

describe('de trainermails', () => {
  it('zetten het e-mailadres en de accountmanager in de kop', () => {
    const { body } = trainerZonder(facts);
    expect(body).toContain('jan@voorbeeld.nl');
    expect(body).toContain('Accountmanager in CC: Dirkje');
  });

  it('zeggen wát er ontbreekt in plaats van een lege regel', () => {
    const kaal = buildMailFacts({ ...input, trainerEmails: [], accountmanager: '' });
    const { body } = trainerZonder(kaal);
    expect(body).toContain('(geen e-mailadres op het trainersbord)');
    expect(body).toContain('(geen accountmanager op het agendabord)');
  });

  it('melden dat de Monday-status al automatisch gezet is', () => {
    // De ZONDER-mail droeg die handeling als huiswerk op; wij doen hem nu zelf.
    expect(trainerZonder(facts).body).toContain('al automatisch');
  });

  it('bevatten het blok met zes vragen niet meer', () => {
    // Een van de vier reparaties uit 04-evaluatierapportage.md.
    expect(trainerMet(facts).body).not.toContain('zes vragen');
  });
});

describe('een training zonder thema', () => {
  it('schrijft "de sessie" en niet "de sessie over ."', () => {
    const zonderThema = buildMailFacts({ ...input, themaNamen: [] });
    expect(aftersalesMet(zonderThema).body).toContain('bij jullie de sessie.');
    expect(trainerMet(zonderThema).body).not.toContain('over  gegeven');
  });
});

/**
 * De klanttitel noemt de klant vaak niet ("De kracht van lichaamstaal"), en dan was een
 * evaluatie in een volle map niet terug te vinden (Dirkje, 12-Oct-2026).
 */
describe('de klant', () => {
  it('staat in de kop, direct onder de training', () => {
    expect(aftersalesMet(facts).body).toContain('Training: Building Boksing\nKlant: Gemeente Emmen');
    expect(trainerZonder(facts).body).toContain('Klant: Gemeente Emmen');
  });

  it('staat in het onderwerp van alle vier de mails', () => {
    for (const mail of [aftersalesMet, aftersalesZonder, trainerMet, trainerZonder]) {
      expect(mail(facts).subject).toContain('Gemeente Emmen – Building Boksing');
    }
  });

  it('komt niet dubbel als de klanttitel hem al noemt', () => {
    const dubbel = buildMailFacts({ ...input, klanttitel: 'Gemeente Emmen agressie' });
    expect(aftersalesMet(dubbel).subject).toContain('Aftersales Gemeente Emmen agressie (');
  });

  it('zegt dat er geen bedrijf gekoppeld is in plaats van een lege regel', () => {
    const zonder = buildMailFacts({ ...input, klant: '' });
    expect(aftersalesMet(zonder).body).toContain('Klant: (geen bedrijf gekoppeld op het agendabord)');
    expect(aftersalesMet(zonder).subject).toContain('Aftersales Building Boksing (');
  });
});

/**
 * Bij Slides stonden beide teksten tussen aanhalingstekens in één opdracht, en moest de
 * accountmanager ze eruit knippen. Bij Vervolg staan ze als twee kant-en-klare alinea's en
 * verwijder je de andere; dat werkt fijn (Dirkje), dus Slides werkt nu ook zo.
 */
describe('het Slides-blok', () => {
  const { body } = aftersalesMet(facts);

  it('geeft twee kant-en-klare varianten, net als Vervolg', () => {
    expect(body).toContain(
      'Variant A: Hierbij vind je ook de slides van de sessie. Handig als naslagwerk.'
    );
    expect(body).toContain('Variant B: In de bijlage vind je ook de slides van de sessie.');
  });

  it('zet geen te kiezen tekst meer tussen aanhalingstekens', () => {
    expect(body).not.toContain('KIES: "');
    expect(body).not.toMatch(/"Hierbij vind je/);
  });
});

/** Kopjes dikgedrukt en Calibri 11, zoals de mails vóór de overstap (Dirkje, 12-Oct-2026). */
describe('de HTML-versie', () => {
  const { body, html } = aftersalesMet(facts);

  it('staat in Calibri 11', () => {
    expect(html).toContain('font-family:Calibri');
    expect(html).toContain('font-size:11pt');
  });

  it('zet de kopjes dikgedrukt', () => {
    for (const kop of ['Evaluatie', 'Individuele evaluatie deelnemers', 'Slides', 'Vervolg']) {
      expect(html).toContain(`<b>${kop}</b>`);
    }
    expect(trainerMet(facts).html).toContain('<b>Individuele evaluatie deelnemers</b>');
  });

  it('maakt de formulierlinks klikbaar', () => {
    expect(aftersalesZonder(facts).html).toContain(
      '<a href="https://forms.gle/P9CBnDgVhbz8iRZp9">https://forms.gle/P9CBnDgVhbz8iRZp9</a>'
    );
  });

  it('laat tekst uit Monday nooit als HTML meelopen', () => {
    const vies = buildMailFacts({ ...input, klanttitel: 'Feedback <script> & meer' });
    const { html: schoon } = aftersalesMet(vies);
    expect(schoon).toContain('Feedback &lt;script&gt; &amp; meer');
    expect(schoon).not.toContain('<script>');
  });

  /** De HTML is een opmaak van de tekst, geen tweede tekst die uit de pas kan lopen. */
  it('zegt woord voor woord hetzelfde als de platte tekst', () => {
    const alsTekst = html
      .replace(/<\/p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
    expect(alsTekst.trimEnd()).toBe(body);
  });
});
