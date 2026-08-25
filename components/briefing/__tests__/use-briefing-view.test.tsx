import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { fakeMonday } from '@components/recommendations/__tests__/fakes';
import { EMPTY_SAVED, type SavedChecklist } from '@lib/briefing/answers';

import { BriefingConflict, type BriefingApi, type BriefingPayload } from '../api';
import { useBriefingView } from '../use-briefing-view';

import type { BriefingTraining } from '@lib/briefing/types';

afterEach(cleanup);

/**
 * De toestand van de app-tab.
 *
 * Het scherp zit in het wisselen van training — **de weergave wordt niet opnieuw gemonteerd**
 * als de adviseur op het volgende item klikt — en in de races die daaruit volgen: een
 * uitgestelde schrijfactie die aan de vorige training toebehoort, en een late eerste
 * contextlezing die het scherm terugzet.
 */

const trainingVoor = (itemId: string, over: Partial<BriefingTraining> = {}): BriefingTraining => ({
  itemId,
  naam: `Training ${itemId}`,
  label: 'JE',
  brie: 'Aanmaken',
  opdrachtgever: `Klant ${itemId}`,
  themas: ['Improvisatietheater'],
  themaInhoud: 'Opening.',
  klanttitel: 'Improvisatietheater',
  duur: '2',
  datum: '2026-10-09',
  tijden: '14:00-16:00',
  groepsgrootte: '30',
  locatie: 'Ermelo',
  voertaal: 'NL',
  klantcontactmoment: 'Telefoon',
  evaluatie: 'Nee',
  ieCode: '',
  accountmanager: null,
  contactpersoon: null,
  trainers: [
    { itemId: '1', naam: 'Frank', telefoon: '', isActeur: false, isCoTrainer: false },
    { itemId: '2', naam: 'Richard', telefoon: '', isActeur: false, isCoTrainer: true },
  ],
  acteuraantal: null,
  opportunityItemId: null,
  achtergrond: 'Iets.',
  missing: [],
  ...over,
});

const payloadVoor = (itemId: string, over: Partial<BriefingPayload> = {}): BriefingPayload => ({
  training: trainingVoor(itemId),
  saved: { ...EMPTY_SAVED, actorAnswered: true },
  token: `token-${itemId}`,
  unreadable: false,
  ...over,
});

interface Opgeslagen {
  readonly itemId: string;
  readonly input: SavedChecklist & { token: string };
}

/**
 * Een logboek van wat er wanneer begon en eindigde.
 *
 * Op tijd toetsen kan hier niet: `waitFor` peilt met tussenpozen van tientallen milliseconden
 * en slikt daarmee precies het venster op waarin de race zit. De volgorde van gebeurtenissen
 * is de eigenschap die we bedoelen, dus die toetsen we rechtstreeks.
 */
function fakeApi(over: {
  payloads?: Record<string, BriefingPayload>;
  conflict?: boolean;
  faalt?: string;
  vertraagGet?: Record<string, number>;
  vertraagSave?: number;
  faaltSave?: string;
}): BriefingApi & { writes: Opgeslagen[]; log: string[] } {
  const writes: Opgeslagen[] = [];
  /**
   * Het token per item, zoals de server het zou bijhouden: een `GET` ná een schrijfactie geeft
   * het verse token terug, niet het oude. Een fake die altijd hetzelfde token teruggaf zou
   * juist de race verbergen waar deze suite naar zoekt.
   */
  const tokens = new Map<string, string>();
  const log: string[] = [];
  return {
    writes,
    log,
    async get(itemId) {
      /**
       * De waarde wordt gelezen op het moment dat het verzoek binnenkomt, en pas daarna komt
       * het antwoord terug. Zo modelleert dit precies de race: een `GET` die vertrekt vóórdat
       * een schrijfactie is geland, en die daarná antwoordt met het verouderde token.
       */
      if (over.faalt !== undefined) {
        throw new Error(over.faalt);
      }
      const basis = over.payloads?.[itemId] ?? payloadVoor(itemId);
      const huidig = tokens.get(itemId);
      const antwoord = huidig === undefined ? basis : { ...basis, token: huidig };
      log.push(`get:start:${itemId}`);
      const wacht = over.vertraagGet?.[itemId];
      if (wacht !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, wacht));
      }
      log.push(`get:end:${itemId}`);
      return antwoord;
    },
    async saveChecklist(itemId, input) {
      writes.push({ itemId, input });
      log.push(`save:start:${itemId}`);
      if (over.vertraagSave !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, over.vertraagSave));
      }
      if (over.faaltSave !== undefined) {
        throw new Error(over.faaltSave);
      }
      if (over.conflict === true) {
        throw new BriefingConflict(null, 'token-van-de-ander');
      }
      const volgend = `na-${writes.length}`;
      tokens.set(itemId, volgend);
      log.push(`save:end:${itemId}`);
      return { saved: input, token: volgend };
    },
  };
}

const OPTIES = { saveDebounceMs: 1 };
const CTX = (itemId: string) => ({ itemId, boardId: '5087396949', theme: 'light' as const });

describe('useBriefingView', () => {
  it('laadt de training uit de context van Monday', async () => {
    const monday = fakeMonday(CTX('900'));
    const { result } = renderHook(() => useBriefingView(monday, fakeApi({}), OPTIES));

    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });
    expect(result.current.itemId).toBe('900');
    expect(result.current.theme).toBe('light');
  });

  it('meldt een leesfout in plaats van een leeg formulier te tonen', async () => {
    const monday = fakeMonday(CTX('900'));
    const { result } = renderHook(() =>
      useBriefingView(monday, fakeApi({ faalt: 'bord onbereikbaar' }), OPTIES)
    );
    await waitFor(() => {
      expect(result.current.status.kind).toBe('error');
    });
  });

  it('slaat een wijziging op nadat het typen tot rust komt', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({});
    const { result } = renderHook(() => useBriefingView(monday, api, OPTIES));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      result.current.setChecklist({ homework: true });
    });
    await waitFor(() => {
      expect(api.writes).toHaveLength(1);
    });
    expect(api.writes[0]?.input.checklist.homework).toBe(true);
    expect(api.writes[0]?.input.token).toBe('token-900');
  });

  /**
   * Twee zetters in één gebeurtenis. `answerActor(false)` zet het antwoord én wist de
   * aangewezen acteurs; lazen die allebei hetzelfde gerenderde concept, dan draaide de tweede
   * de eerste terug — op het scherm én in wat werd opgeslagen.
   */
  it('voegt wijzigingen uit één gebeurtenis samen', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({
      payloads: {
        '900': payloadVoor('900', {
          saved: {
            ...EMPTY_SAVED,
            checklist: { ...EMPTY_SAVED.checklist, trainingActor: true },
            actorAnswered: true,
            actorItemIds: ['2'],
          },
        }),
      },
    });
    const { result } = renderHook(() => useBriefingView(monday, api, OPTIES));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      result.current.answerActor(false);
    });

    expect(result.current.answers.checklist.trainingActor).toBe(false);
    expect(result.current.answers.actorItemIds).toEqual([]);
    await waitFor(() => {
      expect(api.writes).toHaveLength(1);
    });
    expect(api.writes[0]?.input.checklist.trainingActor).toBe(false);
    expect(api.writes[0]?.input.actorItemIds).toEqual([]);
  });

  /** Bevestigen van het voorstel is geen wijziging, maar moet wél vastgelegd worden. */
  it('legt vast dát de acteurvraag beantwoord is', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({ payloads: { '900': payloadVoor('900', { saved: null }) } });
    const { result } = renderHook(() => useBriefingView(monday, api, OPTIES));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });
    expect(result.current.answers.actorAnswered).toBe(false);

    act(() => {
      result.current.answerActor(false);
    });
    await waitFor(() => {
      expect(api.writes).toHaveLength(1);
    });
    expect(api.writes[0]?.input.actorAnswered).toBe(true);
  });

  /**
   * Het voorbeeld wordt in de browser opnieuw uitgerekend. Zou het van de server komen, dan
   * bleef "0 documenten" staan nadat de adviseur precies de acteur aanwees die dat oploste.
   */
  it('rekent het voorbeeld opnieuw uit bij elke wijziging', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({
      payloads: {
        '900': payloadVoor('900', {
          training: trainingVoor('900', { acteuraantal: 1 }),
          saved: {
            ...EMPTY_SAVED,
            checklist: { ...EMPTY_SAVED.checklist, trainingActor: true },
            actorAnswered: true,
          },
        }),
      },
    });
    const { result } = renderHook(() => useBriefingView(monday, api, OPTIES));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    const voor = result.current.status;
    expect(voor.kind === 'loaded' && voor.view.kanGenereren).toBe(false);
    expect(voor.kind === 'loaded' && voor.view.documenten).toEqual([]);

    act(() => {
      result.current.setActorItemIds(['2']);
    });

    const na = result.current.status;
    expect(na.kind === 'loaded' && na.view.kanGenereren).toBe(true);
    expect(na.kind === 'loaded' && na.view.documenten.map((d) => d.role)).toEqual([
      'lead',
      'acteur',
    ]);
  });

  /**
   * Het kritieke geval: Monday vervangt de weergave niet als de adviseur op de volgende
   * training klikt.
   */
  it('houdt de antwoorden bij de training waar ze bij horen', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({
      payloads: {
        '900': payloadVoor('900', {
          saved: {
            ...EMPTY_SAVED,
            checklist: { ...EMPTY_SAVED.checklist, homework: true },
            actorAnswered: true,
          },
        }),
        '901': payloadVoor('901'),
      },
    });
    const { result } = renderHook(() => useBriefingView(monday, api, OPTIES));
    await waitFor(() => {
      expect(result.current.answers.checklist.homework).toBe(true);
    });

    act(() => {
      monday.changeContext(CTX('901'));
    });
    expect(result.current.answers.checklist.homework).toBe(false);

    await waitFor(() => {
      expect(result.current.itemId).toBe('901');
      expect(result.current.status.kind).toBe('loaded');
    });
    expect(result.current.answers.checklist.homework).toBe(false);
  });

  it('schrijft naar de training die op het scherm staat, met háár token', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({});
    const { result } = renderHook(() => useBriefingView(monday, api, OPTIES));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      monday.changeContext(CTX('901'));
    });
    await waitFor(() => {
      expect(result.current.itemId).toBe('901');
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      result.current.setChecklist({ homework: true });
    });
    await waitFor(() => {
      expect(api.writes).toHaveLength(1);
    });
    expect(api.writes[0]?.itemId).toBe('901');
    expect(api.writes[0]?.input.token).toBe('token-901');
  });

  /**
   * Een uitgestelde wijziging hoort bij de training die je verlaat — dus versturen, niet
   * weggooien. Weggooien liet de wijziging van wie een vinkje zet en meteen doorklikt zonder
   * een woord verdwijnen; laten aflopen kan niet, want de timer gaat pas af nadat de volgende
   * training geladen is.
   */
  it('verstuurt een uitgestelde wijziging alsnog bij het wisselen van training', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({});
    const { result } = renderHook(() => useBriefingView(monday, api, { saveDebounceMs: 5_000 }));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      result.current.setChecklist({ homework: true });
    });
    act(() => {
      monday.changeContext(CTX('901'));
    });

    await waitFor(() => {
      expect(api.writes).toHaveLength(1);
    });
    expect(api.writes[0]?.itemId).toBe('900');
    expect(api.writes[0]?.input.token).toBe('token-900');
    expect(api.writes[0]?.input.checklist.homework).toBe(true);
  });

  /**
   * De opslagstatus hoort bij één training. Een verzoek voor A dat afrondt nadat B geladen is
   * toonde anders "opgeslagen" bij B — of erger, een botsing met een knop "Opnieuw laden" voor
   * de verkeerde training.
   */
  it('toont de opslagstatus van de vorige training niet bij de volgende', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({ conflict: true });
    const { result } = renderHook(() => useBriefingView(monday, api, { saveDebounceMs: 5_000 }));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      result.current.setChecklist({ homework: true });
    });
    act(() => {
      monday.changeContext(CTX('901'));
    });

    await waitFor(() => {
      expect(api.writes).toHaveLength(1);
    });
    await waitFor(() => {
      expect(result.current.itemId).toBe('901');
    });
    expect(result.current.save.kind).toBe('rust');
  });

  /**
   * `context()` en `onContextChange` zijn een race. Komt de wijziging naar B binnen vóórdat de
   * belofte voor A is opgelost, dan zou die late belofte het scherm terugzetten op A.
   */
  it('negeert een late eerste contextlezing na een wisseling', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({});
    const { result } = renderHook(() => useBriefingView(monday, api, OPTIES));

    act(() => {
      monday.changeContext(CTX('901'));
    });
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });
    expect(result.current.itemId).toBe('901');
  });

  it('meldt een botsing en neemt het token van de ander niet over', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({ conflict: true });
    const { result } = renderHook(() => useBriefingView(monday, api, OPTIES));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      result.current.setChecklist({ homework: true });
    });
    await waitFor(() => {
      expect(result.current.save.kind).toBe('conflict');
    });

    act(() => {
      result.current.setChecklist({ trainingCycle: true });
    });
    await waitFor(() => {
      expect(api.writes).toHaveLength(2);
    });
    expect(api.writes[1]?.input.token).toBe('token-900');
  });

  /**
   * Onleesbare antwoorden: het formulier staat leeg, dus één vinkje zou onbekende antwoorden
   * overschrijven. Bewerken is daarom geblokkeerd tot iemand dat expliciet wil.
   */
  it('blokkeert bewerken zolang er onleesbare antwoorden staan', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({
      payloads: { '900': payloadVoor('900', { saved: null, unreadable: true }) },
    });
    const { result } = renderHook(() => useBriefingView(monday, api, OPTIES));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });
    expect(result.current.locked).toBe(true);

    act(() => {
      result.current.setChecklist({ homework: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.writes).toHaveLength(0);
    expect(result.current.answers.checklist.homework).toBe(false);

    act(() => {
      result.current.unlock();
    });
    expect(result.current.locked).toBe(false);

    act(() => {
      result.current.setChecklist({ homework: true });
    });
    await waitFor(() => {
      expect(api.writes).toHaveLength(1);
    });
  });

  /**
   * Een mislukte achtergrondflush mag niet verdwijnen.
   *
   * De adviseur navigeert weg, de flush faalt terwijl hij elders kijkt, en bij terugkomst is
   * de wijziging weg én de melding erover ook. Alleen expliciet opnieuw laden ruimt hem op.
   */
  it('bewaart een mislukte schrijfactie tot de training opnieuw geladen wordt', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({ faaltSave: 'redis weg' });
    const { result } = renderHook(() => useBriefingView(monday, api, OPTIES));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      result.current.setChecklist({ homework: true });
    });
    await waitFor(() => {
      expect(result.current.save.kind).toBe('mislukt');
    });

    act(() => {
      monday.changeContext(CTX('901'));
    });
    await waitFor(() => {
      expect(result.current.itemId).toBe('901');
    });
    expect(result.current.save.kind).toBe('rust');

    act(() => {
      monday.changeContext(CTX('900'));
    });
    await waitFor(() => {
      expect(result.current.itemId).toBe('900');
    });
    expect(result.current.save.kind).toBe('mislukt');

    act(() => {
      result.current.refresh();
    });
    await waitFor(() => {
      expect(result.current.save.kind).toBe('rust');
    });
  });

  /**
   * Twee trainingen houden hun eigen uitkomst. Eén hokje liet een late voltooiing van A de
   * botsing van B overschrijven — en die verdween dan van het scherm.
   */
  it('laat de uitkomst van A die van B niet overschrijven', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({ conflict: true, vertraagSave: 30 });
    const { result } = renderHook(() => useBriefingView(monday, api, { saveDebounceMs: 1 }));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      result.current.setChecklist({ homework: true });
    });
    act(() => {
      monday.changeContext(CTX('901'));
    });
    await waitFor(() => {
      expect(result.current.itemId).toBe('901');
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      result.current.setChecklist({ trainingCycle: true });
    });
    await waitFor(() => {
      expect(result.current.save.kind).toBe('conflict');
    });

    // De late botsing van 900 mag die van 901 niet wegdrukken.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(result.current.save.kind).toBe('conflict');
  });

  /**
   * Terugkeren naar een training terwijl haar flush nog loopt.
   *
   * Liepen `GET` en `PUT` door elkaar, dan stond er óf een oud beeld met een vers token — en
   * overschreef de volgende wijziging de geflushte — óf een verlopen token, waarmee de
   * volgende wijziging met onszelf botste.
   *
   * Getoetst op volgorde en niet op tijd: `waitFor` peilt met grote tussenpozen en zou het
   * venster waarin de race zit gewoon overslaan.
   */
  it('laadt een training pas nadat haar lopende schrijfactie klaar is', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({ vertraagSave: 30 });
    const { result } = renderHook(() => useBriefingView(monday, api, { saveDebounceMs: 5_000 }));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      result.current.setChecklist({ homework: true });
    });
    act(() => {
      monday.changeContext(CTX('901'));
    });
    act(() => {
      monday.changeContext(CTX('900'));
    });

    await waitFor(() => {
      expect(result.current.itemId).toBe('900');
      expect(result.current.status.kind).toBe('loaded');
    });

    // De tweede GET voor 900 hoort ná het einde van de schrijfactie te beginnen.
    const saveEnd = api.log.indexOf('save:end:900');
    const tweedeGet = api.log.indexOf('get:start:900', api.log.indexOf('get:end:900') + 1);
    expect(saveEnd).toBeGreaterThan(-1);
    expect(tweedeGet).toBeGreaterThan(saveEnd);
  });

  it('houdt de acteurkeuze en de Monday Challenge bij', async () => {
    const monday = fakeMonday(CTX('900'));
    const api = fakeApi({});
    const { result } = renderHook(() => useBriefingView(monday, api, OPTIES));
    await waitFor(() => {
      expect(result.current.status.kind).toBe('loaded');
    });

    act(() => {
      result.current.setMondayChallenge(true);
    });
    await waitFor(() => {
      expect(api.writes).toHaveLength(1);
    });
    expect(api.writes[0]?.input.mondayChallenge).toBe(true);
  });
});
