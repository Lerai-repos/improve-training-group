/**
 * De oordelen die een provisioning-script velt vóórdat het iets onomkeerbaars doet.
 *
 * Deze scripts maken borden aan, verwijderen rijen en zetten kolommen neer op ITG's live
 * werkruimte. Ze staan in `scripts/`, waar de testconfiguratie niet kijkt — `lib/**` en
 * `components/**` zijn de enige plekken die draaien. Dus staat hier alles wat een BESLISSING
 * is en blijft het script de aanroeper: lezen, schrijven, afdrukken.
 *
 * Alles hier is puur. Geen Monday-client, geen bestandssysteem, geen klok — de tijd komt als
 * argument binnen zodat een test hem kan kiezen.
 */

/**
 * Monday onthoudt een `Idempotency-Key` 30 minuten. Daarna beschermt hij niets meer.
 *
 * Zie `MutateOptions.idempotencyKey` in `mutate.ts`: dezelfde mutatie binnen dat venster wordt
 * onderdrukt, daarbuiten gewoon opnieuw uitgevoerd — en dat is bij `create_board` een tweede
 * bord.
 */
export const IDEMPOTENCY_WINDOW_MS = 30 * 60 * 1000;

/**
 * De bord-ids waar een `board_relation` naartoe wijst, als string.
 *
 * **Monday stuurt ze als GETAL terug.** Elders in dit project is precies dat het verschil
 * tussen "niets geselecteerd" en een werkende kolom; hier zou een vergelijking zonder
 * normalisatie een correcte relatie afkeuren als "wijst naar een ander bord".
 *
 * `null` betekent onleesbaar, en dat is met opzet iets anders dan een lege lijst: onleesbaar
 * mag nooit als "klopt" doorgaan.
 */
export function relationBoardIds(settingsStr: string | null | undefined): readonly string[] | null {
  const settings = parseSettings(settingsStr);
  if (settings === null || !('boardIds' in settings)) {
    return null;
  }
  const { boardIds } = settings;
  if (!Array.isArray(boardIds)) {
    return null;
  }
  const ids: string[] = [];
  for (const id of boardIds) {
    if (typeof id !== 'string' && typeof id !== 'number') {
      return null;
    }
    ids.push(String(id));
  }
  return ids;
}

/** De labels van een statuskolom, gesorteerd zodat de volgorde van Monday niet meetelt. */
export function statusLabels(settingsStr: string | null | undefined): readonly string[] | null {
  const settings = parseSettings(settingsStr);
  if (settings === null || !('labels' in settings)) {
    return null;
  }
  const { labels } = settings;
  if (typeof labels !== 'object' || labels === null || Array.isArray(labels)) {
    return null;
  }
  const out: string[] = [];
  for (const value of Object.values(labels)) {
    if (typeof value !== 'string') {
      return null;
    }
    out.push(value);
  }
  return [...out].sort();
}

function parseSettings(settingsStr: string | null | undefined): Record<string, unknown> | null {
  if (typeof settingsStr !== 'string' || settingsStr.trim() === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(settingsStr);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return { ...parsed };
  } catch {
    return null;
  }
}

/** Wat een kolom moet zijn. Zonder `relationBoardIds`/`statusLabels` telt alleen het type. */
export interface ColumnExpectation {
  readonly id: string;
  readonly type: string;
  readonly relationBoardIds?: readonly string[];
  readonly statusLabels?: readonly string[];
}

export type ColumnVerdict =
  | { kind: 'ok' }
  | { kind: 'wrong_type'; found: string }
  | { kind: 'wrong_relation'; found: readonly string[]; expected: readonly string[] }
  | { kind: 'wrong_labels'; missing: readonly string[] }
  | { kind: 'unreadable_settings' };

/**
 * Klopt een bestaande kolom, of moet een mens ernaar kijken?
 *
 * Het type alleen is niet genoeg, en dat was het gat: een `board_relation` die naar een ander
 * bord wijst heeft hetzelfde type als de goede en werd dus als "bestaat al, niets te doen"
 * gemeld. Zo'n kolom valt niet op — hij staat er, hij is leeg, en niemand merkt het.
 */
export function checkColumn(
  expected: ColumnExpectation,
  actual: { type: string; settings_str?: string | null }
): ColumnVerdict {
  if (actual.type !== expected.type) {
    return { kind: 'wrong_type', found: actual.type };
  }

  if (expected.relationBoardIds !== undefined) {
    const found = relationBoardIds(actual.settings_str);
    if (found === null) {
      return { kind: 'unreadable_settings' };
    }
    /**
     * **Exact** vergelijken, niet als deelverzameling.
     *
     * Een relatie die op `[verwacht, iets anders]` staat bevat het verwachte bord en kwam er
     * dus doorheen als "klopt". De runtime-controle is strenger — `assertColumns` zoekt de
     * letterlijke tekst `"boardIds":[1661151090]`, en die staat niet in
     * `"boardIds":[1661151090,999]`. Zo meldde het inrichtingsscript een bord als goed
     * terwijl de motor het even later weigerde, en dan wijst niets naar de oorzaak.
     */
    const wanted = [...new Set(expected.relationBoardIds)].sort();
    const actualBoards = [...new Set(found)].sort();
    const same =
      wanted.length === actualBoards.length && wanted.every((id, at) => id === actualBoards[at]);
    if (!same) {
      return { kind: 'wrong_relation', found, expected: expected.relationBoardIds };
    }
  }

  if (expected.statusLabels !== undefined) {
    const found = statusLabels(actual.settings_str);
    if (found === null) {
      return { kind: 'unreadable_settings' };
    }
    const missing = expected.statusLabels.filter((label) => !found.includes(label));
    if (missing.length > 0) {
      return { kind: 'wrong_labels', missing };
    }
  }

  return { kind: 'ok' };
}

/**
 * Hoe ver het opruimen van Monday's voorbeeldinhoud is.
 *
 * DRIE toestanden, geen nullable paar. `null` verwart "klaar", "nooit begonnen" en "gestopt
 * tussen het aanmaken en het vastleggen" met elkaar, en juist dat laatste geval is de reden
 * dat dit bestaat.
 *
 * Ids en niet een vlaggetje: een vlag zegt dát er nog iets open staat, niet WAT — en dan moet
 * een hervatting het opnieuw afleiden als "alles wat op het bord staat", wat zodra het
 * register echte rijen bevat het register wíst.
 */
export type SampleState =
  | { phase: 'uncaptured' }
  | { phase: 'captured'; itemIds: string[]; groupIds: string[] }
  | { phase: 'cleared' };

export type SampleCleanupPlan =
  | { kind: 'done' }
  /** Onze kolommen bestaan al: het opruimen is gebeurd, alleen nooit genoteerd. */
  | { kind: 'already_done' }
  | { kind: 'delete'; itemIds: readonly string[]; groupIds: readonly string[] }
  /** Niets van ons op het bord — alles wat er staat is van Monday en mag worden vastgelegd. */
  | { kind: 'capture' };

/**
 * Wat er nog op te ruimen valt, zonder ook maar iets te verwijderen dat van ITG is.
 *
 * De regressie die dit dichtzet: "ruim de voorbeelden op" was geïmplementeerd als "verwijder
 * de eerste 50 items van het bord", uitgevoerd na élke `--apply`. Zodra het Briefings-bord
 * echte regels bevat — en dat is het hele doel van dat bord — wist een herstelrun productie.
 *
 * Onze kolommen worden strikt ná het opruimen aangemaakt. Hun aanwezigheid bewijst dus dat
 * het bord dat stadium voorbij is; hun afwezigheid bewijst dat er nog niets van ons staat.
 */
export function sampleCleanupPlan(
  samples: SampleState,
  board: { columnIds: readonly string[] },
  /** De kolom-ids die dit script zelf aanmaakt — het bewijs dat het bord dit stadium voorbij is. */
  ourColumnIds: readonly string[]
): SampleCleanupPlan {
  if (samples.phase === 'cleared') {
    return { kind: 'done' };
  }
  if (samples.phase === 'captured') {
    return { kind: 'delete', itemIds: samples.itemIds, groupIds: samples.groupIds };
  }
  const ours = new Set(ourColumnIds);
  if (board.columnIds.some((id) => ours.has(id))) {
    return { kind: 'already_done' };
  }
  return { kind: 'capture' };
}

export type CreateVerdict =
  | { kind: 'retry' }
  | { kind: 'refuse'; ageMinutes: number };

/**
 * Mag een `create_board` waarvan we het antwoord nooit zagen opnieuw worden verstuurd?
 *
 * Binnen het venster wel: dezelfde sleutel levert hetzelfde bord op. Daarbuiten niet — de
 * sleutel beschermt niets meer en er is geen bord-id om op te hervatten, dus opnieuw
 * versturen kan een TWEEDE bord opleveren waar niets naar wijst. Een mens moet dan eerst
 * kijken of het er al staat.
 */
export function unresolvedCreateVerdict(startedAt: number, now: number): CreateVerdict {
  const age = now - startedAt;
  if (age > IDEMPOTENCY_WINDOW_MS) {
    return { kind: 'refuse', ageMinutes: Math.round(age / 60_000) };
  }
  return { kind: 'retry' };
}

export type OverrideVerdict = { kind: 'ok' } | { kind: 'refuse'; configured: string };

/**
 * Mag dit script schrijven terwijl de agenda-override aanstaat?
 *
 * `MONDAY_AGENDA_BOARD_ID` richt de pijplijn op een KOPIE van Agenda 2026 — precies bedoeld
 * om niet aan het echte bord te komen. Maar een bord dat hier wordt aangemaakt komt wél in de
 * productiewerkruimte te staan, wijst permanent naar die kopie, en het id gaat de code in. De
 * override later weghalen repareert dat niet.
 *
 * Een droogloop mag altijd: die maakt niets aan en laat juist zien waar het heen zou wijzen.
 *
 * Leeg telt niet als override, want `agendaBoardId()` gebruikt `||` en valt dan terug op
 * productie.
 */
export function agendaOverrideVerdict(input: {
  configured: string | undefined;
  production: string;
  apply: boolean;
  allowOverride: boolean;
}): OverrideVerdict {
  const configured = (input.configured ?? '').trim();
  if (!input.apply || input.allowOverride || configured === '' || configured === input.production) {
    return { kind: 'ok' };
  }
  return { kind: 'refuse', configured };
}
