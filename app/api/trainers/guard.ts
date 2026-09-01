import { NextResponse } from 'next/server';

import {
  authorizeToken,
  capabilityPolicyFromEnv,
  readBearerToken,
  sessionTokenConfigFromEnv,
  type AuthorizedCaller,
} from '@lib/recommend';
import { createRedisClient, createUpstashKvStore } from '@lib/recommend/kv';
import { createStatsStore, type StatsStore } from '@lib/evaluations';

/**
 * De proloog van het trainer-overzicht: kennen we deze aanroeper, en mag hij kijken?
 *
 * Dezelfde sessietokens en dezelfde capability-configuratie als de andere twee tabs — het
 * is één Monday-app met één set gebruikers. Een eigen stelsel ernaast zou betekenen dat wie
 * uit het ene is gezet nog via het andere binnenkomt.
 *
 * Minder dan de andere twee guards, en dat klopt: dit eindpunt leest één Redis-sleutel,
 * schrijft niets, en gaat niet over één training — er is dus geen bord om te controleren en
 * geen mutatieclient nodig. Méér op één punt: het vraagt `full`, zie hieronder.
 */

export class TrainerOverviewNotConfigured extends Error {}

export interface TrainerOverviewDeps {
  readonly stats: StatsStore;
  readonly auth: Parameters<typeof authorizeToken>[1];
}

type Guarded =
  | { ok: true; caller: AuthorizedCaller; deps: TrainerOverviewDeps }
  | { ok: false; response: NextResponse };

const refuse = (status: number, error: string): { ok: false; response: NextResponse } => ({
  ok: false,
  response: NextResponse.json({ success: false, error }, { status }),
});

/** Ontbrekende omgevingsvariabelen zijn *niet ingericht*, niet *kapot* — 503, geen 500. */
function buildDeps(): TrainerOverviewDeps {
  try {
    return {
      stats: createStatsStore(createUpstashKvStore(createRedisClient())),
      auth: { session: sessionTokenConfigFromEnv(), policy: capabilityPolicyFromEnv() },
    };
  } catch (error) {
    throw new TrainerOverviewNotConfigured(
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function guard(request: Request): Promise<Guarded> {
  // Vóór er iets van configuratie wordt gelezen: een verzoek zonder token krijgt hetzelfde
  // antwoord, ingericht of niet, zodat een halve deploy zijn ene echte probleem niet
  // verstopt achter 500's op anonieme requests.
  const token = readBearerToken(request);
  if (token === null) {
    return refuse(401, 'unauthorized');
  }

  let deps: TrainerOverviewDeps;
  try {
    deps = buildDeps();
  } catch (error) {
    if (error instanceof TrainerOverviewNotConfigured) {
      console.error('trainer overview: niet ingericht', error.message);
      return refuse(503, 'het trainer-overzicht is niet ingericht');
    }
    throw error;
  }

  /**
   * `full`, niet `view`.
   *
   * Dit hele scherm bestáát uit cijfers, en `lib/recommend/capabilities.ts` zegt met
   * zoveel woorden dat evaluatiecijfers achter `full` horen — de aanbevelingenlijst laat
   * ze weg voor wie alleen `view` heeft (`toRestrictedRow`). Een beperkte vorm heeft hier
   * geen betekenis: een tabel met trainers zonder cijfers is geen overzicht. Dus vragen we
   * het recht dat bij de gegevens hoort, in plaats van het laagste dat de deur opent.
   *
   * In productie heeft iedereen vandaag `view,plan,full`, dus dit verandert voor niemand
   * iets — het is de grens die klopt zodra ITG hem ooit smaller zet.
   */
  const auth = await authorizeToken(token, deps.auth, 'full');
  if (!auth.ok) {
    return refuse(auth.status, auth.error);
  }

  return { ok: true, caller: auth.caller, deps };
}
