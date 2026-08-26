import { NextResponse } from 'next/server';

import {
  authorizeToken,
  capabilityPolicyFromEnv,
  createItemBoardReader,
  readBearerToken,
  sessionTokenConfigFromEnv,
  type AuthorizedCaller,
  type ItemBoardReader,
} from '@lib/recommend';
import { createUpstashChecklistStore, type ChecklistStore } from '@lib/briefing/checklist-store';
import { agendaBoardId, MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient, type MondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient, type MondayMutationClient } from '@lib/monday/mutate';
import { createRedisClient } from '@lib/recommend/kv';

/**
 * De proloog die elke briefing-route deelt: kennen we deze aanroeper, mag hij dit, en gáát het
 * over een training die van ons is?
 *
 * Eén implementatie in plaats van drie, want dit is de volledige toegangscontrole van de tab.
 * Dezelfde opzet én dezelfde tokencontrole als
 * `app/api/recommendations/[itemId]/guard.ts`: het is dezelfde Monday-app, met dezelfde
 * sessietokens en dezelfde gebruikers. Twee stelsels naast elkaar zou betekenen dat wie uit
 * het ene is gezet nog via het andere binnenkomt.
 */

export class BriefingNotConfigured extends Error {}

export interface BriefingDeps {
  readonly monday: MondayGraphQLClient;
  /** Schrijven naar Monday. Apart, want de leesclient weigert elk `mutation`-document. */
  readonly mutate: MondayMutationClient;
  readonly checklists: ChecklistStore;
  readonly boards: ItemBoardReader;
  readonly boardId: string;
  /** Ook hierbinnen: ontbrekende sessievariabelen zijn net zo goed "niet ingericht". */
  readonly auth: Parameters<typeof authorizeToken>[1];
}

type Guarded =
  | { ok: true; caller: AuthorizedCaller; deps: BriefingDeps }
  | { ok: false; response: NextResponse };

const refuse = (status: number, error: string): { ok: false; response: NextResponse } => ({
  ok: false,
  response: NextResponse.json({ success: false, error }, { status }),
});

/**
 * Alles wat ontbreekt is *niet geconfigureerd*, niet *kapot*.
 *
 * De Redis-client, `agendaBoardId()` én de sessie- en capability-configuratie werpen allemaal
 * op ontbrekende omgevingsvariabelen. Die buiten deze grens laten leverde een kale 500 op voor
 * precies de toestand die deze klasse bestaat om als 503 te melden — een deploy die nog niet af
 * is, met een voor de hand liggende oplossing.
 */
function buildDeps(deadlines: GuardDeadlines): BriefingDeps {
  const token = process.env.MONDAY_API_TOKEN;
  if (token === undefined || token === '') {
    throw new BriefingNotConfigured('MONDAY_API_TOKEN ontbreekt');
  }
  try {
    const monday = createMondayGraphQLClient({
      token,
      apiVersion: MONDAY_API_VERSION,
      deadlineMs: deadlines.read,
    });
    return {
      monday,
      /**
       * Eén deadline voor álles wat deze aanroep doet.
       *
       * Zonder gaat de retry-begroting van Monday zijn eigen gang, en die kan het budget van
       * de route opeten voordat er ook maar iets is weggeschreven — waarna het platform de
       * functie afkapt op een moment dat wij niet meer kunnen opruimen.
       */
      mutate: createMondayMutationClient({
        token,
        apiVersion: MONDAY_API_VERSION,
        deadlineMs: deadlines.write ?? deadlines.read,
      }),
      checklists: createUpstashChecklistStore(createRedisClient()),
      boards: createItemBoardReader(monday),
      boardId: agendaBoardId(),
      auth: { session: sessionTokenConfigFromEnv(), policy: capabilityPolicyFromEnv() },
    };
  } catch (error) {
    throw new BriefingNotConfigured(error instanceof Error ? error.message : String(error));
  }
}

/**
 * `view` mag lezen, `plan` mag schrijven.
 *
 * De checklist opslaan en straks genereren vallen allebei onder `plan`: ze veranderen wat er
 * bij een trainer terechtkomt. Alleen kijken wat er zou gebeuren is `view`.
 */
export interface GuardDeadlines {
  /** Voor het lezen: mag samen met de rest van het werk aflopen. */
  readonly read?: () => number | null;
  /**
   * Voor het schrijven naar Monday, en met opzet LATER.
   *
   * De administratie draait pas nadat de documenten in SharePoint staan. Deelt hij zijn
   * deadline met het uploaden, dan is die bij een afgebroken upload al verstreken en faalt
   * élke mutatie meteen met "deadline exceeded" — waarna de bestanden die er wél staan
   * nergens zijn vastgelegd. Precies de wees die het deelresultaat hoort te voorkomen.
   */
  readonly write?: () => number | null;
}

export async function guard(
  request: Request,
  required: 'view' | 'plan',
  deadlines: GuardDeadlines = {}
): Promise<Guarded> {
  // Vóór er configuratie gelezen wordt: een verzoek zonder token krijgt hetzelfde antwoord, of
  // deze omgeving nu is ingericht of niet. Anders verbergt een half ingerichte deploy zijn
  // enige echte probleem achter 500's op anoniem verkeer.
  const token = readBearerToken(request);
  if (token === null) {
    return refuse(401, 'unauthorized');
  }

  let deps: BriefingDeps;
  try {
    deps = buildDeps(deadlines);
  } catch (error) {
    if (error instanceof BriefingNotConfigured) {
      console.error('briefing: niet geconfigureerd', error.message);
      return refuse(503, 'de briefing-tab is niet geconfigureerd');
    }
    throw error;
  }

  const auth = await authorizeToken(token, deps.auth, required);
  if (!auth.ok) {
    return refuse(auth.status, auth.error);
  }

  return { ok: true, caller: auth.caller, deps };
}

/**
 * Staat dit item wel op het agendabord?
 *
 * Zonder deze controle is het item-id uit de URL een vrij te kiezen sleutel in KV. Een
 * planner met `plan`-rechten kon zo willekeurige sleutels aanmaken, en via het botsingsantwoord
 * — dat de huidige stand meestuurt — de opgeslagen waarde van een item búiten deze tab
 * teruglezen. Het leespad krijgt dit gratis omdat `readBriefingTraining` van het ingestelde
 * bord leest; het schrijfpad raakt Monday niet en heeft de controle dus apart nodig.
 */
export async function requireAgendaItem(
  deps: BriefingDeps,
  itemId: string
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  let board: string | null;
  try {
    board = await deps.boards.readBoardId(itemId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('briefing: bordcontrole mislukt', { itemId, message });
    // Niet kunnen vaststellen dát het mag is geen toestemming. 502 en geen 403: het ligt aan
    // ons of aan Monday, niet aan de aanroeper.
    return refuse(502, 'kon niet vaststellen bij welk bord dit item hoort');
  }
  if (board !== deps.boardId) {
    // 404 en geen 403: of het item bestaat is niets wat deze aanroeper hoort te leren.
    return refuse(404, 'deze training staat niet op het agendabord');
  }
  return { ok: true };
}

/** Een JSON-body lezen, of de 400 die zegt dat het er geen was. */
export async function readJsonBody(
  request: Request
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return refuse(400, 'invalid json');
  }
}
