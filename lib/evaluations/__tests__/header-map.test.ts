import { describe, expect, it } from 'vitest';

import { normalizeHeader, resolveColumns } from '../header-map';

/**
 * Three header shapes exist in the wild and all three must resolve:
 *   - `Code` — the LIVE sheet, and what every n8n node matches on (`e.json.Code`);
 *   - `IE-code` — the older 2024/2025 sheets;
 *   - the full question text — what a CSV export of the same tab produces.
 *
 * The headers below are copied verbatim from the two exports in `docs/`, embedded
 * newline and accidental double space included.
 */

const NL_HEADER = [
  'Tijdstempel',
  'Voer hier de code in die met je is gedeeld. Zorg ervoor dat je de code precies invoert zoals die aan jou is doorgegeven.',
  'Hoe heb je het programma inhoudelijk (bijv. structuur, werkvormen, genoeg uitdaging) ervaren?',
  'Vind je dat er in voldoende mate praktijkgericht en actief gewerkt is?',
  'Heeft de sessie concrete handvatten geboden om zelf mee aan de slag te kunnen?',
  'Vond je de trainer vakkundig, bekwaam en in staat om het onderwerp te behandelen?',
  'Hoe heb je de communicatie en omgang van de trainer ervaren?',
  'Welk eindcijfer zou je de sessie geven?',
  'Lijkt het je waardevol om in een opvolgsessie je nieuwe kennis, inzichten en technieken na te bespreken en verder te verdiepen?',
  'Op welk(e) aspect(en) van de sessie kijk je positief terug en waarom?',
  'Waar zie jij nog ruimte voor verbetering of aanpassing van deze training?',
  'Kolom 8',
  'Kolom 2',
  'Kolom 3',
  'Kolom 4',
  'Kolom 5',
  'Kolom 6',
];

const EN_HEADER = [
  'Tijdstempel',
  'Enter the code that was shared with you here.\nMake sure to enter the code exactly as it was provided to you.',
  'How did you experience the program in terms of content (e.g., structure, teaching methods,  challenging enough)?',
  'Do you feel that there was a sufficient emphasis on practical, hands-on work and active learning?',
  'Did the session provide concrete tools and techniques for you to use?',
  'Did you find the trainer knowledgeable, competent, and capable of addressing the subject?',
  'How did you experience the communication and interaction style of the trainer?',
  'What final grade would you give to the session?',
  'Do you think it would be valuable to have a follow-up session to discuss and further deepen your new knowledge, insights, and techniques?',
  'Which aspect(s) of the session do you look back on positively and why?',
  'Where do you see room for improvement for this training?',
];

/** Narrow a resolution to its success case, failing loudly with the reason if not. */
function resolved(header: readonly string[]) {
  const result = resolveColumns(header);
  if (!result.ok) {
    throw new Error(`expected a resolution, got: ${result.reason}`);
  }
  return result.columns;
}

describe('normalizeHeader', () => {
  it('collapses an embedded newline — the EN code header has one', () => {
    expect(normalizeHeader('Enter the code here.\nMake sure')).toBe('enter the code here make sure');
  });

  it('collapses the accidental double space in the EN program question', () => {
    expect(normalizeHeader('teaching methods,  challenging')).toBe('teaching methods challenging');
  });

  it('strips punctuation, diacritics and case', () => {
    expect(normalizeHeader('  Wélk EINDcijfer?  ')).toBe('welk eindcijfer');
  });

  it('collapses a non-breaking space like any other whitespace', () => {
    expect(normalizeHeader('IE code')).toBe('ie code');
  });
});

describe('resolveColumns', () => {
  describe('the three header shapes', () => {
    it('resolves the live sheet’s "Code" by exact alias', () => {
      expect(resolved(['Tijdstempel', 'Code', 'Welk eindcijfer zou je de sessie geven?']).code).toBe(
        1
      );
    });

    it('resolves the older sheets’ "IE-code"', () => {
      expect(resolved(['IE-code', 'Eindcijfer']).code).toBe(0);
    });

    it('resolves the NL export’s full question text', () => {
      const columns = resolved(NL_HEADER);

      expect(columns.code).toBe(1);
      expect(columns.grade).toBe(7);
      expect(columns.timestamp).toBe(0);
    });

    it('resolves the EN export, embedded newline and all', () => {
      const columns = resolved(EN_HEADER);

      expect(columns.code).toBe(1);
      expect(columns.grade).toBe(7);
      expect(columns.timestamp).toBe(0);
    });
  });

  describe('refusing to guess', () => {
    /**
     * Two columns called `Code` is drift, not something to pick a winner from. Guessing
     * here attributes every response through whichever one happens to be first.
     */
    it('fails when an alias matches two columns', () => {
      const result = resolveColumns(['Code', 'Code', 'Eindcijfer']);

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.reason).toMatch(/code/i);
    });

    it('fails when a marker matches two columns rather than taking the first', () => {
      const result = resolveColumns([
        'Voer hier de code in die met je is gedeeld.',
        'Tweede kolom met het woord code erin',
        'Eindcijfer',
      ]);

      expect(result.ok).toBe(false);
    });

    /**
     * The load-bearing decision. ITG edits these sheets — the NL export already carries
     * six operator-added `Kolom N` columns — and a column inserted before the code
     * column would make every response carry a GRADE as its code, match nothing, and
     * produce a perfectly green run that silently loses 3.207 responses. A positional
     * default converts a loud failure into a silent one.
     */
    it('never falls back to a column position', () => {
      const result = resolveColumns(['Tijdstempel', 'Iets anders', 'Nog iets']);

      expect(result.ok).toBe(false);
    });

    it('reports the headers it saw, so the failure is actionable', () => {
      const result = resolveColumns(['Tijdstempel', 'Iets anders']);

      expect(result.ok ? [] : result.headers).toEqual(['tijdstempel', 'iets anders']);
    });

    it('fails when the grade column is missing, even though the code resolved', () => {
      const result = resolveColumns(['Code', 'Iets anders']);

      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.reason).toMatch(/grade|cijfer/i);
    });
  });

  describe('the timestamp is optional', () => {
    it('resolves without it', () => {
      const columns = resolved(['Code', 'Eindcijfer']);

      expect(columns.timestamp).toBeNull();
      expect(columns.code).toBe(0);
      expect(columns.grade).toBe(1);
    });
  });

  /**
   * An alias must beat a marker: a sheet with both a real `Code` column and a question
   * mentioning the word must resolve to the real one, not fail as ambiguous.
   */
  it('prefers an exact alias over a substring marker', () => {
    const columns = resolved([
      'Voer hier de code in die met je is gedeeld.',
      'Code',
      'Welk eindcijfer zou je de sessie geven?',
    ]);

    expect(columns.code).toBe(1);
  });
});

/**
 * The eight report-only columns.
 *
 * These exist for the evaluation REPORT (`docs/build/04-evaluatierapportage.md`): five
 * more 1-5 questions, the follow-up question, and the two free-text fields the quote
 * lists are built from. The recommendation statistics never read them.
 *
 * That asymmetry is the reason they are all OPTIONAL. `resolveColumns` is shared with
 * the nightly job, which needs only the code and the grade. Making a question column
 * required would mean that ITG renaming a question — something that has already
 * happened once — takes down the trainer statistics for a column that job never opens.
 */
describe('the report columns', () => {
  const REPORT_FIELDS = [
    'program',
    'practical',
    'tools',
    'trainerExpertise',
    'trainerCommunication',
    'followUp',
    'positive',
    'improvement',
  ] as const;

  it('resolves all eight in the NL export', () => {
    const columns = resolved(NL_HEADER);

    expect({
      program: columns.program,
      practical: columns.practical,
      tools: columns.tools,
      trainerExpertise: columns.trainerExpertise,
      trainerCommunication: columns.trainerCommunication,
      followUp: columns.followUp,
      positive: columns.positive,
      improvement: columns.improvement,
    }).toEqual({
      program: 2,
      practical: 3,
      tools: 4,
      trainerExpertise: 5,
      trainerCommunication: 6,
      followUp: 8,
      positive: 9,
      improvement: 10,
    });
  });

  /**
   * The EN sheet asks the same nine questions in different words, so every field needs
   * a marker in both languages. Written as its own assertion rather than folded into
   * the NL one, because a marker that happens to match both is the exception here.
   */
  it('resolves all eight in the EN export', () => {
    const columns = resolved(EN_HEADER);

    expect({
      program: columns.program,
      practical: columns.practical,
      tools: columns.tools,
      trainerExpertise: columns.trainerExpertise,
      trainerCommunication: columns.trainerCommunication,
      followUp: columns.followUp,
      positive: columns.positive,
      improvement: columns.improvement,
    }).toEqual({
      program: 2,
      practical: 3,
      tools: 4,
      trainerExpertise: 5,
      trainerCommunication: 6,
      followUp: 8,
      positive: 9,
      improvement: 10,
    });
  });

  /**
   * The live sheet and the 2024/2025 archives carry a bare `Code` column and no
   * question text at all. Those must keep reading exactly as they do today.
   */
  it('resolves a header that has none of them, leaving each null', () => {
    const columns = resolved(['Code', 'Eindcijfer']);

    for (const field of REPORT_FIELDS) {
      expect(columns[field], field).toBeNull();
    }
    expect(columns.code).toBe(0);
    expect(columns.grade).toBe(1);
  });

  /**
   * The property that protects the nightly job. A renamed question is a gap in the
   * report, never a failed read.
   */
  it('keeps reading when one question has been renamed beyond recognition', () => {
    const renamed = NL_HEADER.map((header, index) => (index === 8 ? 'Vraag 7' : header));

    const columns = resolved(renamed);

    expect(columns.followUp).toBeNull();
    expect(columns.code).toBe(1);
    expect(columns.grade).toBe(7);
    expect(columns.positive).toBe(9);
  });

  /**
   * Ambiguity on an OPTIONAL column yields null rather than failing the whole read.
   * That is still "refusing to guess" — it just refuses at the granularity of the one
   * column nobody's statistics depend on, instead of taking the corpus down with it.
   */
  it('yields null for an ambiguous report column instead of failing the read', () => {
    const result = resolveColumns([
      'Code',
      'Eindcijfer',
      'Lijkt het je waardevol om in een opvolgsessie verder te verdiepen?',
      'Tweede vraag over een opvolgsessie',
    ]);

    expect(result.ok).toBe(true);
    expect(result.ok ? result.columns.followUp : 'unresolved').toBeNull();
  });

  /** Ambiguity on a REQUIRED column stays fatal. Nothing about that changes. */
  it('still fails on an ambiguous required column', () => {
    expect(resolveColumns(['Code', 'Code', 'Eindcijfer']).ok).toBe(false);
  });
});
