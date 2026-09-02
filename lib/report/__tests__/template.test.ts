import { describe, expect, it } from 'vitest';

import { chartColours } from '../colours';
import { buildReportModel } from '../model';
import { renderReportHtml } from '../template';

import type { LabelArtwork } from '../assets';
import type { EvaluationResponse } from '@lib/evaluations/types';
import type { LabelRecord } from '@lib/labels/read';

const label: LabelRecord = {
  code: 'IT',
  volledigeNaam: 'Incompany Trainer',
  kleur: '#0A2B58',
  term: 'Training',
  rapportterm: 'de training',
  evaluatieformulier: '',
  website: '',
  inventarisatieformulier: '',
  logo: null,
  voorblad: null,
  achterblad: null,
};

const geenPlaatjes: LabelArtwork = {
  logo: null,
  voorblad: null,
  achterblad: null,
  problems: [],
};

const response = (
  over: Partial<EvaluationResponse['answers']> & { grade?: number | null } = {}
) => {
  const { grade = 8, ...answers } = over;
  const r: EvaluationResponse = {
    source: { documentId: 'csv:test', sheetName: 'x', label: 'nl' },
    rowNumber: 2,
    rawCode: '251050',
    grade,
    receivedAtRaw: null,
    answers: {
      program: 4,
      practical: 4,
      tools: 4,
      trainerExpertise: 5,
      trainerCommunication: 5,
      followUp: 'Ja',
      positive: null,
      improvement: null,
      ...answers,
    },
  };
  return r;
};

const render = (
  responses: EvaluationResponse[],
  training?: Partial<Parameters<typeof buildReportModel>[0]['training']>
) => {
  const model = buildReportModel({
    training: {
      itemId: '1',
      klanttitel: 'Feedback geven',
      contactPersoon: 'Lisa de Vries, Mark Jansen',
      trainerNamen: ['Jan Bakker'],
      ...training,
    },
    label,
    responses,
  });
  return renderReportHtml(model, geenPlaatjes, chartColours(label.kleur));
};

describe('renderReportHtml', () => {
  it('zet de aanhef met beide voornamen', () => {
    expect(render([response()])).toContain('Beste Lisa en Mark,');
  });

  it('gebruikt enkelvoud bij één trainer en meervoud bij twee', () => {
    expect(render([response()])).toContain('onze trainer <strong>Jan</strong>');
    const twee = render([response()], { trainerNamen: ['Jan Bakker', 'Piet Jansen'] });
    expect(twee).toContain('onze trainers <strong>Jan en Piet</strong>');
    expect(twee).toContain('Over de trainers');
  });

  /**
   * De klanttitel komt uit Monday en de citaten uit een Google Form. Dit is de enige plek
   * waar die tekst het document in gaat, dus dit is de test die telt.
   */
  it('ontsnapt een klanttitel met HTML erin', () => {
    const html = render([response()], { klanttitel: 'Feedback <script>alert(1)</script> & meer' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; meer');
  });

  it('ontsnapt een citaat met aanhalingstekens en tekens', () => {
    const html = render([response({ positive: 'Top! "echt" <goed> & fijn' })]);
    expect(html).not.toContain('<goed>');
    expect(html).toContain('&quot;echt&quot; &lt;goed&gt; &amp; fijn');
  });

  it('ontsnapt een contactpersoon met een teken erin', () => {
    const html = render([response()], { contactPersoon: '<b>Lisa</b> de Vries' });
    expect(html).not.toContain('<b>Lisa</b>');
  });

  /**
   * De balkhoogtes staan als `style` in de HTML en worden NIET door een script gezet. Dat is
   * het hele punt van de herbouw: een script plus een CSS-overgang is een wedloop met het
   * vastleggen van de PDF, en die verlies je soms.
   */
  it('zet de balkhoogtes als inline style, zonder script', () => {
    const html = render([response({ grade: 8 }), response({ grade: 8 }), response({ grade: 10 })]);
    expect(html).toContain('style="height:67%"');
    expect(html).toContain('style="height:33%"');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('transition');
  });

  it('zet de taartpunten als kant-en-klare conic-gradient', () => {
    const html = render([response({ followUp: 'Ja' }), response({ followUp: 'Nee' })]);
    expect(html).toContain('conic-gradient(from -90deg,');
    expect(html).toContain('Ja: 1');
    expect(html).toContain('Nee: 1');
  });

  it('toont een streepje in plaats van NaN als niemand een cijfer gaf', () => {
    const html = render([response({ grade: null })]);
    expect(html).toContain('>—<');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('null');
  });

  it('zegt het als een vraag onbeantwoord bleef', () => {
    expect(render([response({ program: null })])).toContain('Geen antwoorden op deze vraag');
  });

  it('zet een vervangtekst neer als er geen citaten zijn', () => {
    expect(render([response()])).toContain('Geen feedback ontvangen.');
  });

  /** Zonder afbeeldingen mag er geen kapotte `<img>` of lege paginavullende sectie ontstaan. */
  it('laat voor- en achterblad weg als het label ze niet heeft', () => {
    const html = render([response()]);
    expect(html).not.toContain('class="page document-section bleed"');
    expect(html).not.toContain('src=""');
  });

  it('gebruikt de merkkleur van het label', () => {
    expect(render([response()])).toContain('--brand:#0A2B58');
  });

  /** Papierformaat is bewust nét onder A4; dat is de bestaande reparatie tegen witte randjes. */
  it('drukt af op 209,5 x 296 mm', () => {
    expect(render([response()])).toContain('@page{size:209.5mm 296mm;margin:0;}');
  });
});
