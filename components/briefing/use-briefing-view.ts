'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EMPTY_SAVED, type SavedChecklist } from '@lib/briefing/answers';
import { buildTabView, type TabView } from '@lib/briefing/tab';

import { BriefingConflict, type BriefingApi, type BriefingPayload } from './api';

import type {
  Appearance,
  MondayBridge,
  MondayContext,
} from '@components/recommendations/monday-client';
import type { BriefingChecklist } from '@lib/briefing/blocks';

/**
 * De toestand van de app-tab: laden, bewerken, opslaan.
 *
 * ## Alles hangt aan één item-id
 *
 * **De itemweergave wordt niet opnieuw gemonteerd als de adviseur op de volgende training
 * klikt** — alleen de context verandert. Elke brok toestand draagt daarom het item-id waar hij
 * bij hoort en telt alleen mee als dat overeenkomt met de huidige context. Zonder dat toont de
 * tab één render lang de antwoorden van A onder de kop van B, en schrijft een opslagactie in
 * dat venster A's checklist naar B.
 *
 * Dat geldt óók voor het token en voor lopende verzoeken, en dat is subtieler: één gedeeld
 * hokje voor het token betekent dat een uitgestelde schrijfactie voor A het token van B
 * oppakt zodra B geladen is.
 *
 * ## Het scherm wordt hier uitgerekend, niet op de server
 *
 * `buildTabView` draait op het concept, dus het aantal documenten en de blokkades bewegen mee
 * met elk vinkje. Een bevroren beeld van de server bleef "0 documenten" tonen nadat de
 * adviseur precies de acteur had aangewezen die dat oploste.
 */

/**
 * Lang genoeg dat typen niet elke aanslag wegschrijft, kort genoeg dat wegklikken zelden iets
 * kost. Injecteerbaar zodat tests niet echt hoeven te wachten.
 */
const SAVE_DEBOUNCE_MS = 800;

export type BriefingStatus =
  | { kind: 'loading' }
  | { kind: 'loaded'; payload: BriefingPayload; view: TabView }
  | { kind: 'error'; message: string };

/** Waar het opslaan staat. `conflict` is geen fout maar een vraag aan de adviseur. */
export type SaveState =
  | { kind: 'rust' }
  | { kind: 'bezig' }
  | { kind: 'bewaard' }
  | { kind: 'conflict' }
  | { kind: 'mislukt'; message: string };

export interface UseBriefingView {
  readonly itemId: string | null;
  readonly theme: Appearance | null;
  readonly status: BriefingStatus;
  readonly save: SaveState;
  /** De antwoorden zoals ze nu op het scherm staan, inclusief onbewaarde wijzigingen. */
  readonly answers: SavedChecklist;
  /**
   * Staat er iets opgeslagen dat niet te lezen is? Dan is bewerken geblokkeerd tot de adviseur
   * bevestigt dat het overschreven mag worden.
   */
  readonly locked: boolean;
  setChecklist(next: Partial<BriefingChecklist>): void;
  setActorItemIds(next: readonly string[]): void;
  setMondayChallenge(next: boolean): void;
  /** De acteurvraag beantwoorden. Zet ook `actorAnswered`, ook bij hetzelfde antwoord. */
  answerActor(werktMee: boolean): void;
  /** Het onleesbare record bewust overschrijven. */
  unlock(): void;
  refresh(): void;
  /**
   * De openstaande wijziging nú wegschrijven, en zeggen of het concept daarna veilig staat.
   *
   * Nodig vóór het genereren: de server leest de opgeslagen checklist, niet het scherm. Wie
   * een vinkje zet en binnen de 800 ms doorklikt naar Genereren zou anders een document
   * krijgen dat op de vórige antwoorden is gebouwd — zonder een woord, want alles ziet er
   * goed uit.
   *
   * `false` betekent: er is niets weggeschreven dat klopt. Bij een botsing of een mislukte
   * opslag is dat óók zo, en dan is doorgaan met genereren erger dan wachten.
   */
  flush(): Promise<boolean>;
}

export interface BriefingViewOptions {
  readonly saveDebounceMs?: number;
}

/** Eén uitgestelde schrijfactie, met het item waar hij bij hoort. */
interface Pending {
  readonly itemId: string;
  readonly answers: SavedChecklist;
}

type Owned<T> = { readonly itemId: string | null; readonly value: T };

export function useBriefingView(
  monday: MondayBridge,
  api: BriefingApi,
  options: BriefingViewOptions = {}
): UseBriefingView {
  const debounceMs = options.saveDebounceMs ?? SAVE_DEBOUNCE_MS;

  const [context, setContext] = useState<MondayContext | null>(null);
  const [loaded, setLoaded] = useState<Owned<BriefingStatus>>({
    itemId: null,
    value: { kind: 'loading' },
  });
  const [draft, setDraft] = useState<Owned<SavedChecklist>>({ itemId: null, value: EMPTY_SAVED });
  /**
   * De opslagstatus **per training**, niet één hokje met een label eraan.
   *
   * Eén hokje betekende dat een achtergrondschrijfactie voor A die afrondt terwijl B in
   * botsing staat de status van B overschreef — en de kijker liet die dan als `rust` zien,
   * waarmee B's botsing van het scherm verdween.
   */
  const [saves, setSaves] = useState<ReadonlyMap<string, SaveState>>(new Map());
  /**
   * Dezelfde kaart als `saves`, maar leesbaar zónder opnieuw te renderen.
   *
   * `flush` kijkt ná het wachten hoe het is afgelopen. Zou hij `saves` uit de sluiting
   * lezen, dan leest hij de stand van het moment waarop hij werd aangeroepen — vóór de
   * schrijfactie die hij zelf net startte — en meldt hij een botsing als succes.
   */
  const savesRef = useRef<ReadonlyMap<string, SaveState>>(new Map());
  const [unlocked, setUnlocked] = useState<Owned<boolean>>({ itemId: null, value: false });

  /**
   * Eén plek die een opslagstatus weghaalt, uit BEIDE kaarten.
   *
   * Alleen `saves` legen liet `savesRef` op de oude mislukking staan. Het scherm zei dan
   * "rust" terwijl `flush` nog steeds die mislukking las — en dan weigert Genereren te
   * werken tot er toevallig een volgende wijziging goed wordt opgeslagen, zonder dat iets
   * uitlegt waarom.
   */
  const wisSave = useCallback((id: string) => {
    const zonder = new Map(savesRef.current);
    zonder.delete(id);
    savesRef.current = zonder;
    setSaves((vorig) => {
      const volgende = new Map(vorig);
      volgende.delete(id);
      return volgende;
    });
  }, []);

  const zetSave = useCallback((id: string, value: SaveState) => {
    savesRef.current = new Map(savesRef.current).set(id, value);
    setSaves((vorig) => new Map(vorig).set(id, value));
  }, []);
  const [nonce, setNonce] = useState(0);

  const itemId = context?.itemId ?? null;

  /** Het token per item, zodat een late schrijfactie nooit dat van een ander item pakt. */
  const tokens = useRef(new Map<string, string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Wát er nog geschreven moet worden, niet alleen dát er een timer loopt.
   *
   * Nodig om bij het wisselen van training de uitgestelde wijziging alsnog te versturen in
   * plaats van hem weg te gooien: de adviseur die een vinkje zet en binnen 800 ms doorklikt
   * zag zijn wijziging anders zonder een woord verdwijnen.
   */
  const pending = useRef<Pending | null>(null);
  /** Eén schrijfactie tegelijk per item: twee met hetzelfde token botsen met zichzelf. */
  const inFlight = useRef(new Map<string, Promise<void>>());

  /**
   * Is er ooit een contextwijziging gezien?
   *
   * `monday.context()` en `onContextChange` zijn een race: komt de wijziging naar B binnen
   * vóórdat de belofte voor A is opgelost, dan zet die late belofte het scherm terug op A.
   */
  const changed = useRef(false);

  useEffect(() => {
    let alive = true;
    monday
      .context()
      .then((c) => {
        if (alive && !changed.current) {
          setContext(c);
        }
      })
      .catch((error: unknown) => {
        /**
         * Zonder context weten we niet welk item dit is en ook niet welk thema — en dan
         * rendert de weergave met opzet een lege doorzichtige schil. Die zou dan voorgoed leeg
         * blijven. Deze melding is het enige dat de adviseur vertelt waarom hij niets ziet.
         */
        if (!alive || changed.current) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setLoaded({ itemId: null, value: { kind: 'error', message } });
      });
    const off = monday.onContextChange((c) => {
      changed.current = true;
      setContext(c);
    });
    return () => {
      alive = false;
      off();
    };
  }, [monday]);

  const bewaar = useCallback(
    (taakVoor: Pending, keepalive = false) => {
      const vorige = inFlight.current.get(taakVoor.itemId) ?? Promise.resolve();
      /**
       * In de rij, niet parallel. Twee schrijfacties met hetzelfde token laten de tweede
       * botsen met de eerste — een botsing met zichzelf, die op het scherm zou verschijnen
       * als "een collega was je voor". Het token wordt pas ín de taak gelezen, zodat elke
       * volgende het verse token van zijn voorganger gebruikt.
       */
      const taak = vorige.then(async () => {
        const token = tokens.current.get(taakVoor.itemId);
        if (token === undefined) {
          return;
        }
        zetSave(taakVoor.itemId, { kind: 'bezig' });
        try {
          const result = await api.saveChecklist(
            taakVoor.itemId,
            { ...taakVoor.answers, token },
            { keepalive }
          );
          tokens.current.set(taakVoor.itemId, result.token);
          zetSave(taakVoor.itemId, { kind: 'bewaard' });
        } catch (error: unknown) {
          if (error instanceof BriefingConflict) {
            // Het token van de tegenpartij overnemen zou hun wijziging wissen zodra de
            // adviseur nog één vinkje zet. Dus: zeggen wat er is, en opnieuw laden aanbieden.
            zetSave(taakVoor.itemId, { kind: 'conflict' });
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          zetSave(taakVoor.itemId, { kind: 'mislukt', message });
        }
      });
      inFlight.current.set(taakVoor.itemId, taak);
    },
    [api, zetSave]
  );

  useEffect(() => {
    if (itemId === null) {
      return;
    }
    const controller = new AbortController();
    /**
     * Eerst de lopende schrijfactie voor dít item afwachten.
     *
     * Na een flush bij het wegnavigeren kan de adviseur terugkomen vóórdat die klaar is. Dan
     * liepen `GET` en `PUT` door elkaar: wint de schrijfactie, dan staat er een oud beeld op
     * het scherm mét een vers token, en overschrijft de volgende wijziging de geflushte
     * wijziging. Wint de `GET`, dan draagt hij een verlopen token en botst de volgende
     * wijziging met onszelf.
     */
    const lopend = inFlight.current.get(itemId);
    setLoaded({ itemId, value: { kind: 'loading' } });
    /**
     * Een botsing of een mislukte schrijfactie blijft staan tot iemand hem oplost.
     *
     * Opnieuw laden wiste hem anders stilzwijgend — inclusief het geval waarin een
     * achtergrondflush voor déze training was mislukt terwijl de adviseur elders keek. Dan
     * was de wijziging weg én de melding erover ook. Alleen `refresh()` ruimt hem op, want
     * dat is de adviseur die zegt: ik heb het gezien.
     */
    setSaves((vorig) => {
      const huidig = vorig.get(itemId);
      if (huidig === undefined || huidig.kind === 'conflict' || huidig.kind === 'mislukt') {
        return vorig;
      }
      const volgende = new Map(vorig);
      volgende.delete(itemId);
      return volgende;
    });
    void Promise.resolve(lopend)
      .then(() => {
        if (controller.signal.aborted) {
          throw new DOMException('aborted', 'AbortError');
        }
        return api.get(itemId, controller.signal);
      })
      .then((payload) => {
        tokens.current.set(itemId, payload.token);
        setLoaded({
          itemId,
          value: { kind: 'loaded', payload, view: buildTabView(payload.training, payload.saved) },
        });
        setDraft({ itemId, value: payload.saved ?? EMPTY_SAVED });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setLoaded({ itemId, value: { kind: 'error', message } });
      });
    return () => {
      controller.abort();
      /**
       * De uitgestelde wijziging hoort bij de training die je verlaat — dus versturen, niet
       * weggooien. Hem laten aflopen kan niet: de timer zou pas afgaan nadat de volgende
       * training geladen is. Weggooien mocht ook niet, want dan verdwijnt de wijziging van
       * wie een vinkje zet en binnen 800 ms doorklikt, zonder een woord.
       *
       * `taakVoor` draagt zijn eigen item-id en pakt het token uit de kaart, dus dit schrijft
       * naar A terwijl B al op het scherm staat.
       */
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const openstaand = pending.current;
      pending.current = null;
      if (openstaand !== null) {
        bewaar(openstaand);
      }
    };
  }, [api, bewaar, itemId, nonce]);

  const answers = useMemo(
    () => (draft.itemId === itemId ? draft.value : EMPTY_SAVED),
    [draft, itemId]
  );

  /**
   * Het scherm, opnieuw uitgerekend op het concept. Zo bewegen het aantal documenten en de
   * blokkades mee met elk vinkje, zonder de server erbij te halen.
   */
  const status = useMemo<BriefingStatus>(() => {
    // Een contextfout hoort bij geen enkel item: hij wordt opgeslagen onder `itemId: null` en
    // geldt zolang er geen context is.
    if (loaded.itemId === null && loaded.value.kind === 'error' && itemId === null) {
      return loaded.value;
    }
    if (loaded.itemId !== itemId) {
      return { kind: 'loading' };
    }
    if (loaded.value.kind !== 'loaded') {
      return loaded.value;
    }
    return {
      kind: 'loaded',
      payload: loaded.value.payload,
      view: buildTabView(loaded.value.payload.training, answers),
    };
  }, [answers, itemId, loaded]);

  const unreadable =
    loaded.itemId === itemId && loaded.value.kind === 'loaded' && loaded.value.payload.unreadable;
  const locked = unreadable && !(unlocked.itemId === itemId && unlocked.value);

  /**
   * Eén functionele update, en de schrijfactie plannen op wát eruit kwam.
   *
   * Twee zetters in één gebeurtenis — de acteurvraag op nee zetten wist óók de aangewezen
   * acteurs — lazen allebei hetzelfde gerenderde concept, waardoor de tweede de eerste
   * terugdraaide. Zowel op het scherm als in wat er werd opgeslagen.
   */
  const wijzig = useCallback(
    (maak: (huidig: SavedChecklist) => SavedChecklist) => {
      const doel = itemId;
      if (doel === null || locked) {
        return;
      }
      setDraft((vorig) => {
        const basis = vorig.itemId === doel ? vorig.value : EMPTY_SAVED;
        const volgende = maak(basis);
        if (timer.current !== null) {
          clearTimeout(timer.current);
        }
        pending.current = { itemId: doel, answers: volgende };
        timer.current = setTimeout(() => {
          timer.current = null;
          const openstaand = pending.current;
          pending.current = null;
          if (openstaand !== null) {
            bewaar(openstaand);
          }
        }, debounceMs);
        return { itemId: doel, value: volgende };
      });
    },
    [bewaar, debounceMs, itemId, locked]
  );

  const setChecklist = useCallback(
    (next: Partial<BriefingChecklist>) => {
      wijzig((huidig) => ({ ...huidig, checklist: { ...huidig.checklist, ...next } }));
    },
    [wijzig]
  );

  const setActorItemIds = useCallback(
    (next: readonly string[]) => {
      wijzig((huidig) => ({ ...huidig, actorItemIds: next }));
    },
    [wijzig]
  );

  const setMondayChallenge = useCallback(
    (next: boolean) => {
      wijzig((huidig) => ({ ...huidig, mondayChallenge: next }));
    },
    [wijzig]
  );

  /**
   * De acteurvraag beantwoorden, ook als het antwoord hetzelfde blijft.
   *
   * Het voorstel van Monday staat al als gekozen radioknop op het scherm, dus wie het
   * bevestigt levert geen wijziging op. Zonder deze aparte zetter zou "bevestigd" nooit
   * vastgelegd worden — en bleef genereren geblokkeerd op een vraag die beantwoord ís.
   */
  const answerActor = useCallback(
    (werktMee: boolean) => {
      wijzig((huidig) => ({
        ...huidig,
        checklist: { ...huidig.checklist, trainingActor: werktMee },
        actorItemIds: werktMee ? huidig.actorItemIds : [],
        actorAnswered: true,
      }));
    },
    [wijzig]
  );

  const unlock = useCallback(() => {
    if (itemId !== null) {
      setUnlocked({ itemId, value: true });
    }
  }, [itemId]);

  /**
   * Een laatste poging als de iframe verdwijnt.
   *
   * Monday vervangt of verbergt de weergave zonder te waarschuwen; een wijziging die nog in de
   * debounce zat is dan weg. Best-effort en geen garantie — het ophalen van een vers token kan
   * de race alsnog verliezen.
   */
  useEffect(() => {
    const flush = (): void => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const openstaand = pending.current;
      pending.current = null;
      if (openstaand !== null) {
        bewaar(openstaand, true);
      }
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
    };
  }, [bewaar]);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  const refresh = useCallback(() => {
    // De adviseur zegt: ik heb de botsing of de fout gezien. Pas dán mag hij weg.
    if (itemId !== null) {
      wisSave(itemId);
    }
    setNonce((n) => n + 1);
  }, [itemId, wisSave]);

  /**
   * Alles wat nog openstaat nú wegschrijven, en wachten tot het klaar is.
   *
   * De timer wordt afgebroken zodat de uitgestelde schrijfactie niet ook nog een keer gaat;
   * `bewaar` zet zichzelf in dezelfde rij als de lopende schrijfacties, dus wachten op die
   * rij is wachten op álles wat voor dit item onderweg is.
   *
   * De uitkomst komt uit `saves`, niet uit het feit dat de belofte klaar is: een botsing of
   * een mislukking rondt óók netjes af, en die twee mogen nooit als "veilig opgeslagen"
   * gelezen worden.
   */
  const flush = useCallback(async (): Promise<boolean> => {
    const doel = itemId;
    if (doel === null) {
      return false;
    }
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const openstaand = pending.current;
    pending.current = null;
    if (openstaand !== null) {
      bewaar(openstaand);
    }
    await (inFlight.current.get(doel) ?? Promise.resolve());
    const stand = savesRef.current.get(doel);
    return stand === undefined || stand.kind === 'rust' || stand.kind === 'bewaard';
  }, [bewaar, itemId]);

  return {
    itemId,
    theme: context?.theme ?? null,
    status,
    /**
     * Alleen de opslagstatus van de training die op het scherm staat. Een verzoek voor A dat
     * afrondt nadat B geladen is toonde anders "opgeslagen" — of erger, een botsing met een
     * knop "Opnieuw laden" — bij de verkeerde training.
     */
    save: (itemId === null ? undefined : saves.get(itemId)) ?? { kind: 'rust' },
    answers,
    locked,
    setChecklist,
    setActorItemIds,
    setMondayChallenge,
    answerActor,
    unlock,
    refresh,
    flush,
  };
}
