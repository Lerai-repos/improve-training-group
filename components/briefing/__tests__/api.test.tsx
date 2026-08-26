import { afterEach, describe, expect, it, vi } from 'vitest';

import { BriefingApiError, BriefingConflict, BriefingPlanChanged, createBriefingApi } from '../api';

import type { MondayBridge } from '@components/recommendations/monday-client';

/**
 * De transportlaag, en met name wat er met een 409 gebeurt.
 *
 * Dit is precies het stuk dat een keer stilletjes kapot was: het bijgewerkte plan werd wél
 * meegestuurd door de server, maar niet in de fout gezet — waardoor de herstelweg
 * onbereikbaar was en de adviseur alleen een kale melding zag. De hooktests merkten dat niet,
 * want die maken de fout zelf aan. Deze suite gaat dus door `fetch` heen.
 */

const monday: MondayBridge = {
  context: () => Promise.reject(new Error('niet nodig')),
  onContextChange: () => () => undefined,
  sessionToken: () => Promise.resolve('token'),
  api: () => Promise.reject(new Error('niet nodig')),
};

function antwoord(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    )
  );
}

const PLAN = {
  stage: 'planned',
  folderPath: 'General/1. JE/5. Klanten/Calduran',
  folderExists: true,
  conflicts: ['Briefing.docx'],
  related: [],
  filenames: ['Briefing.docx'],
  planToken: 'abc.def',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generate', () => {
  it('geeft een plan terug', async () => {
    antwoord(200, { success: true, data: PLAN });

    const uit = await createBriefingApi(monday).generate('900');

    expect(uit).toMatchObject({ stage: 'planned', planToken: 'abc.def' });
  });

  /**
   * DE regressie. De server stuurt het bijgewerkte plan mee juist zodat de adviseur kan zien
   * wát er veranderde; kwam dat niet in de fout terecht, dan was `BriefingPlanChanged`
   * onbereikbaar en bleef er een kale melding over.
   */
  it('maakt van een 409 mét plan een BriefingPlanChanged, inclusief het plan', async () => {
    antwoord(409, {
      success: false,
      error: 'er is iets veranderd',
      data: { ...PLAN, changed: 'files' },
    });

    const fout = await createBriefingApi(monday)
      .generate('900', { confirmExisting: true, planToken: 'oud' })
      .catch((error: unknown) => error);

    expect(fout).toBeInstanceOf(BriefingPlanChanged);
    expect(fout instanceof BriefingPlanChanged && fout.plan.changed).toBe('files');
    expect(fout instanceof BriefingPlanChanged && fout.plan.conflicts).toEqual(['Briefing.docx']);
  });

  /**
   * Genereren gebruikt 409 óók voor onleesbare invoer en geweigerde schrijfacties. Die
   * dragen geen plan, en moeten de échte melding houden in plaats van te stranden op een
   * ontbrekend opslagtoken.
   */
  it('houdt de melding van een 409 zonder plan', async () => {
    antwoord(409, { success: false, error: 'de checklist is niet te lezen' });

    const fout = await createBriefingApi(monday)
      .generate('900')
      .catch((error: unknown) => error);

    expect(fout).toBeInstanceOf(BriefingApiError);
    expect(fout instanceof Error && fout.message).toBe('de checklist is niet te lezen');
  });
});

describe('saveChecklist', () => {
  /** Alléén het opslaan gebruikt 409 als opslagbotsing; die weg blijft bestaan. */
  it('leest een 409 wél als opslagbotsing', async () => {
    antwoord(409, { success: false, data: { saved: null, token: 'vers' } });

    const fout = await createBriefingApi(monday)
      .saveChecklist('900', {
        checklist: {
          ownGroup: false,
          sameGroup: false,
          trainingCycle: false,
          homework: false,
          preparatoryAssignment: false,
          trainingActor: false,
        },
        actorItemIds: [],
        mondayChallenge: false,
        actorAnswered: true,
        token: 'oud',
      })
      .catch((error: unknown) => error);

    expect(fout).toBeInstanceOf(BriefingConflict);
    expect(fout instanceof BriefingConflict && fout.token).toBe('vers');
  });
});
