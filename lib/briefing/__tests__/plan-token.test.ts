import { describe, expect, it } from 'vitest';

import { planChangeReason, planFingerprint, trainingFingerprint } from '../plan-token';

/**
 * De vingerafdruk waar het bevestigen aan hangt.
 *
 * Twee heel verschillende oorzaken delen één melding — "het plan is verschoven" — en de
 * adviseur moet ze uit elkaar kunnen houden. Bij gewijzigde bestanden klopt het formulier op
 * het scherm nog; bij een gewijzigde checklist niet, en dan zou hij bevestigen wat hij niet
 * ziet.
 */

const BASIS = {
  folderPath: 'General/1. JE/5. Klanten/Calduran',
  folderExists: true,
  filenames: ['Briefing.docx'],
  conflicts: [] as readonly string[],
  checklistToken: 'token-1',
};

describe('planFingerprint', () => {
  it('is gelijk voor hetzelfde plan', () => {
    expect(planFingerprint(BASIS)).toBe(planFingerprint({ ...BASIS }));
  });

  /** De volgorde waarin Monday of SharePoint dingen teruggeeft is geen wijziging. */
  it('trekt zich niets aan van de volgorde', () => {
    const a = planFingerprint({ ...BASIS, filenames: ['a.docx', 'b.docx'] });
    const b = planFingerprint({ ...BASIS, filenames: ['b.docx', 'a.docx'] });
    expect(a).toBe(b);
  });

  it('verandert als er een botsing bij komt', () => {
    expect(planFingerprint({ ...BASIS, conflicts: ['Briefing.docx'] })).not.toBe(
      planFingerprint(BASIS)
    );
  });

  it('verandert als de checklist wijzigt', () => {
    expect(planFingerprint({ ...BASIS, checklistToken: 'token-2' })).not.toBe(
      planFingerprint(BASIS)
    );
  });
});

describe('trainingFingerprint', () => {
  const TRAINING = { itemId: '900', locatie: 'Ermelo', tijden: '14:00-16:00', themas: ['A'] };

  it('is gelijk voor dezelfde training', () => {
    expect(trainingFingerprint(TRAINING)).toBe(trainingFingerprint({ ...TRAINING }));
  });

  /**
   * De volgorde waarin Monday kolommen teruggeeft is geen wijziging. Zonder dit zou een
   * identieke training soms een andere vingerafdruk krijgen, en melden we een wijziging die
   * er niet is.
   */
  it('trekt zich niets aan van de sleutelvolgorde', () => {
    const omgekeerd = Object.fromEntries(Object.entries(TRAINING).reverse());
    expect(trainingFingerprint(omgekeerd)).toBe(trainingFingerprint(TRAINING));
  });

  /**
   * Velden die NIET in de bestandsnaam zitten maar wél in het document. Precies deze konden
   * tijdens het renderen wijzigen zonder dat er iets opviel.
   */
  it('ziet een gewijzigde locatie of tijd', () => {
    expect(trainingFingerprint({ ...TRAINING, locatie: 'Utrecht' })).not.toBe(
      trainingFingerprint(TRAINING)
    );
    expect(trainingFingerprint({ ...TRAINING, tijden: '09:00-12:00' })).not.toBe(
      trainingFingerprint(TRAINING)
    );
  });

  it('kijkt ook in geneste waarden', () => {
    expect(trainingFingerprint({ ...TRAINING, themas: ['B'] })).not.toBe(
      trainingFingerprint(TRAINING)
    );
  });
});

describe('planChangeReason', () => {
  const oud = planFingerprint(BASIS);

  it('noemt een gewijzigde map "files"', () => {
    const nieuw = planFingerprint({ ...BASIS, conflicts: ['Briefing.docx'] });
    expect(planChangeReason(oud, nieuw)).toBe('files');
  });

  it('noemt een gewijzigde checklist "input"', () => {
    const nieuw = planFingerprint({ ...BASIS, checklistToken: 'token-2' });
    expect(planChangeReason(oud, nieuw)).toBe('input');
  });

  /**
   * Allebei tegelijk, en de invoer wint.
   *
   * Alleen op het bestandsdeel toetsen las dit als `files`, waarna het scherm de verouderde
   * antwoorden liet staan en gewoon liet bevestigen — terwijl de generatie op de antwoorden
   * van de collega gebouwd zou worden.
   */
  it('kiest "input" als er tegelijk een bestand én de checklist wijzigde', () => {
    const nieuw = planFingerprint({
      ...BASIS,
      conflicts: ['Briefing.docx'],
      checklistToken: 'token-2',
    });

    expect(planChangeReason(oud, nieuw)).toBe('input');
  });

  /** Een ontbrekend of onzinnig token is geen bewijs dat alleen de map bewoog. */
  it('behandelt een ontbrekend token als een gewijzigde invoer', () => {
    expect(planChangeReason(undefined, oud)).toBe('input');
    expect(planChangeReason('rommel', oud)).toBe('input');
  });
});
