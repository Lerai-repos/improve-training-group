import { NextResponse } from 'next/server';

import { resolveTrainerOverview } from '@lib/evaluations';

import { guard } from '../guard';

export const runtime = 'nodejs';

/**
 * GET /api/trainers/overview — de hele roster met evaluatiecijfers, voor de bordweergave.
 *
 * Eén Redis-lezing, geen Monday-aanroep en geen namen: de rijen dragen externe id's, en de
 * weergave zoekt de namen client-side op via de Monday-sessie van de planner zelf. Zo staat
 * er nergens op onze kant een lijst van wie welk cijfer heeft.
 *
 * **`full` is vereist, niet `view`.** Het antwoord bestaat volledig uit evaluatiecijfers, en
 * `lib/recommend/capabilities.ts` legt die achter `full` — de aanbevelingenlijst laat ze weg
 * voor wie alleen `view` heeft. Een beperkte vorm bestaat hier niet: een trainerstabel zonder
 * cijfers is geen overzicht. De guard doet die controle; zie `../guard.ts`.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const allowed = await guard(request);
    if (!allowed.ok) {
      return allowed.response;
    }

    const data = await resolveTrainerOverview(allowed.deps.stats);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    // De details gaan naar het log, nooit naar de aanroeper: Redis-foutteksten dragen
    // hostnamen en sleutelnamen, en dit eindpunt is bereikbaar voor iedereen in het account.
    console.error(
      'GET /api/trainers/overview failed',
      error instanceof Error ? error.stack : String(error)
    );
    return NextResponse.json({ success: false, error: 'internal error' }, { status: 500 });
  }
}
