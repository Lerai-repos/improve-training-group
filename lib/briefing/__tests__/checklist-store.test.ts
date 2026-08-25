import { describe, expect, it } from 'vitest';

import { EMPTY_CHECKLIST } from '../blocks';
import { validateChecklist, type SavedChecklist } from '../answers';
import { createMemoryChecklistStore } from '../checklist-store';

/**
 * De antwoorden van de adviseur.
 *
 * Het gaat hier niet om het opslaan zelf maar om wat er gebeurt als twee schrijfacties elkaar
 * kruisen: `conceptInhoud` is een tekstvak waar iemand een half programma in typt, en dat mag
 * niet verdwijnen omdat een tweede tabblad openstond of een antwoord wegviel.
 */

const ANTWOORD: SavedChecklist = {
  checklist: { ...EMPTY_CHECKLIST, trainingActor: true, homework: true },
  actorItemIds: ['2'],
  mondayChallenge: false,
  actorAnswered: true,
};

describe('checklist-store', () => {
  it('geeft niets terug voor een training die nog niet is aangeraakt', async () => {
    const store = createMemoryChecklistStore();
    const snapshot = await store.read('1');
    expect(snapshot.saved).toBeNull();
    expect(snapshot.unreadable).toBe(false);
  });

  it('slaat op en leest terug', async () => {
    const store = createMemoryChecklistStore();
    const leeg = await store.read('1');
    const uit = await store.save('1', { ...ANTWOORD, token: leeg.token });
    expect(uit.kind).toBe('ok');
    expect((await store.read('1')).saved).toEqual(ANTWOORD);
  });

  it('houdt trainingen uit elkaar', async () => {
    const store = createMemoryChecklistStore();
    const leeg = await store.read('1');
    await store.save('1', { ...ANTWOORD, token: leeg.token });
    expect((await store.read('2')).saved).toBeNull();
  });

  /**
   * De reden dat er überhaupt een token is: twee tabbladen, of twee mensen. Wie met een
   * verouderd token schrijft krijgt te horen dát er iets veranderd is, mét de huidige stand,
   * zodat de tab het kan tonen in plaats van er stilletjes overheen te schrijven.
   */
  it('weigert een schrijfactie met een verouderd token', async () => {
    const store = createMemoryChecklistStore();
    const leeg = await store.read('1');
    await store.save('1', { ...ANTWOORD, token: leeg.token });

    const uit = await store.save('1', {
      checklist: { ...EMPTY_CHECKLIST, trainingCycle: true },
      actorItemIds: [],
      mondayChallenge: false,
      actorAnswered: true,
      token: leeg.token,
    });
    expect(uit.kind).toBe('conflict');
    expect(uit.saved).toEqual(ANTWOORD);
  });

  /**
   * Redis legt vast, het antwoord valt weg, de client probeert opnieuw met het token dat hij
   * nog heeft. Een naïeve CAS meldt dan "een collega heeft dit gewijzigd" over het eigen werk
   * van de adviseur. Zelfde inhoud betekent dus geslaagd — en `savedAt` verschilt altijd, dus
   * dit moet op betekenis vergelijken en niet op bytes.
   */
  it('ziet dezelfde schrijfactie twee keer als geslaagd', async () => {
    const store = createMemoryChecklistStore();
    const leeg = await store.read('1');
    await store.save('1', { ...ANTWOORD, token: leeg.token });

    const nogmaals = await store.save('1', { ...ANTWOORD, token: leeg.token });
    expect(nogmaals.kind).toBe('ok');
    expect(nogmaals.saved).toEqual(ANTWOORD);
  });

  /** De volgorde van de acteurs is geen wijziging; anders botst een herhaling alsnog. */
  it('trekt zich niets aan van de volgorde van de acteur-ids', async () => {
    const store = createMemoryChecklistStore();
    const leeg = await store.read('1');
    const twee = { ...ANTWOORD, actorItemIds: ['2', '5'] };
    await store.save('1', { ...twee, token: leeg.token });

    const nogmaals = await store.save('1', {
      ...twee,
      actorItemIds: ['5', '2'],
      token: leeg.token,
    });
    expect(nogmaals.kind).toBe('ok');
  });

  it('geeft na een geslaagde schrijfactie een token waarmee je verder kunt', async () => {
    const store = createMemoryChecklistStore();
    const leeg = await store.read('1');
    const eerste = await store.save('1', { ...ANTWOORD, token: leeg.token });

    const tweede = await store.save('1', {
      checklist: { ...EMPTY_CHECKLIST, trainingCycle: true },
      actorItemIds: [],
      mondayChallenge: false,
      actorAnswered: true,
      token: eerste.token,
    });
    expect(tweede.kind).toBe('ok');
  });

  it('bewaart de concept-inhoud van de adviseur', async () => {
    const store = createMemoryChecklistStore();
    const leeg = await store.read('1');
    const eigen = {
      checklist: { ...EMPTY_CHECKLIST, conceptInhoud: 'Eigen opening.\nEigen afsluiting.' },
      actorItemIds: [],
      mondayChallenge: false,
      actorAnswered: true,
    };
    await store.save('1', { ...eigen, token: leeg.token });
    expect((await store.read('1')).saved?.checklist.conceptInhoud).toBe(
      'Eigen opening.\nEigen afsluiting.'
    );
  });
});

describe('validateChecklist', () => {
  /**
   * `selectBlocks` wérpt hierop. Zou dit als opgeslagen toestand kunnen bestaan, dan komt de
   * tab er niet meer uit: elke poging tot samenstellen valt om op iets wat de adviseur alleen
   * kan repareren door een vinkje uit te zetten dat hij niet meer ziet.
   */
  it('weigert de twee antwoorden op dezelfde vraag samen', () => {
    expect(
      validateChecklist({
        checklist: { ...EMPTY_CHECKLIST, ownGroup: true, sameGroup: true },
        actorItemIds: [],
        mondayChallenge: false,
        actorAnswered: true,
      })
    ).toMatch(/niet allebei/);
  });

  it('weigert een aangewezen acteur terwijl de acteurvraag op nee staat', () => {
    expect(
      validateChecklist({
        checklist: { ...EMPTY_CHECKLIST, trainingActor: false },
        actorItemIds: ['2'],
        mondayChallenge: false,
        actorAnswered: true,
      })
    ).toMatch(/acteurvraag op nee/);
  });

  it('weigert een concept-inhoud die niet in Redis hoort', () => {
    expect(
      validateChecklist({
        checklist: { ...EMPTY_CHECKLIST, conceptInhoud: 'x'.repeat(20_001) },
        actorItemIds: [],
        mondayChallenge: false,
        actorAnswered: true,
      })
    ).toMatch(/hoogstens/);
  });

  it('laat een normaal antwoord door', () => {
    expect(validateChecklist(ANTWOORD)).toBeNull();
  });
});
