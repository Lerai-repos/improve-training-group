import { NextResponse } from 'next/server';

import { buildGenerateContext } from '@lib/briefing/context';
import { readBriefingTraining } from '@lib/briefing/read';
import { createBriefingRecorder } from '@lib/briefing/record';
import { runGenerate } from '@lib/briefing/run-generate';
import { siteConfigFromEnv } from '@lib/sharepoint/config';
import { createGraphClient, graphConfigFromEnv } from '@lib/sharepoint/graph';
import { createSharePointStore, resolveSiteId } from '@lib/sharepoint/store';
import { amsterdamToday } from '@lib/evaluations';
import { log } from '@lib/logger';

import { guard, readJsonBody, requireAgendaItem } from '../guard';

/**
 * POST /api/briefing/[itemId]/generate — de knop.
 *
 * Twee standen, gestuurd door `confirmExisting` in de body:
 *
 * - **zonder** (of `false`): plannen. Kijkt waar het document heen zou gaan en wat er al
 *   ligt, en maakt of schrijft **niets**. Ligt er al een briefing, dan komt dat als
 *   `conflicts` terug en toont de tab de bevestiging.
 * - **met `true`**: schrijven. Rendert per ontvanger en zet de bestanden neer, met een
 *   `(v2)` naast wat er al lag.
 *
 * Waarom dat vlaggetje er is: ITG bewerkt het gegenereerde Word-bestand met de hand — extra
 * tekst, en soms een plaatje van hoe een traject in de offerte stond. Dat bestand ís het
 * bestand dat wij schrijven, dus er mag geen enkel pad bestaan dat het vervangt zonder dat
 * een mens het heeft gezien.
 *
 * Wat hier staat is alleen nog de bedrading: klokken, toegang, clients, en het vertalen van
 * uitkomsten naar statuscodes. De volgorde van beslissingen zelf staat in `runGenerate`,
 * omdat een Next-route niets anders mag exporteren dan zijn HTTP-methoden en de logica hier
 * dus onbereikbaar zou zijn voor een test.
 */

export const runtime = 'nodejs';
/** Negen sjablonen, tot acht ontvangers, plus Google en SharePoint. Ruim, maar begrensd. */
export const maxDuration = 300;

/**
 * Onze eigen deadline, ruim onder `maxDuration`.
 *
 * `maxDuration` is geen deadline die je kunt vangen: het platform kapt de functie af en dan
 * is er geen `catch` meer. Wat er dan al geüpload is blijft achter zonder dat iemand het
 * vastlegt — precies de wees die het deelresultaat hoort te voorkomen. Zelf afbreken levert
 * een gewone fout op, en daar komt het deelresultaat nog wél uit.
 */
const RUN_DEADLINE_MS = 240_000;

/**
 * De administratie krijgt eigen tijd, ná de deadline van het uploaden.
 *
 * Ze draait pas als de documenten er staan. Deelt ze haar deadline met Graph, dan is die bij
 * een afgebroken upload al verstreken en faalt élke mutatie meteen — waarna precies de
 * bestanden die het deelresultaat wilde redden alsnog nergens zijn vastgelegd. Nog steeds
 * ruim binnen `maxDuration`.
 */
const BOOKKEEPING_DEADLINE_MS = 275_000;

interface Body {
  readonly confirmExisting?: boolean;
  readonly planToken?: string;
}

function parseBody(raw: unknown): Body | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const confirm = 'confirmExisting' in raw ? raw.confirmExisting : undefined;
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    return null;
  }
  const planToken = 'planToken' in raw ? raw.planToken : undefined;
  if (planToken !== undefined && typeof planToken !== 'string') {
    return null;
  }
  return { confirmExisting: confirm, planToken };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  const { itemId } = await params;
  /**
   * Eén absolute deadline, meteen bij binnenkomst.
   *
   * Later beginnen laat de klok pas lopen ná de authenticatie en de bordcontrole, en die
   * bordcontrole mag van Monday's eigen retry-begroting minutenlang duren. Dan is het budget
   * al op vóórdat deze timer bestaat, en kapt het platform de functie af op een moment dat wij
   * niets meer kunnen opruimen.
   *
   * Dezelfde deadline gaat naar de lees- én schrijfclient van Monday en naar Graph, zodat
   * niemand er zijn eigen begroting naast houdt.
   */
  const startedMs = Date.now();
  const deadline = startedMs + RUN_DEADLINE_MS;
  const afbreken = new AbortController();
  const timer = setTimeout(() => {
    afbreken.abort();
  }, RUN_DEADLINE_MS);

  /**
   * Een eigen, latere begrenzing voor het herstel.
   *
   * Zonder eigen signaal kan een blijven hangende herstelvraag de route over de platformgrens
   * duwen — en dan draait de administratie niet meer, waarmee precies de wees ontstaat die dit
   * herstel moest voorkomen. Zelfde klok als die administratie, want ze horen bij elkaar:
   * eerst uitzoeken wát er staat, dan het vastleggen.
   */
  const herstelAfbreken = new AbortController();
  const herstelTimer = setTimeout(() => {
    herstelAfbreken.abort();
  }, BOOKKEEPING_DEADLINE_MS);

  try {
    // `plan`, niet `view`: dit maakt documenten die bij trainers terechtkomen.
    const guarded = await guard(request, 'plan', {
      read: () => deadline,
      write: () => startedMs + BOOKKEEPING_DEADLINE_MS,
    });
    if (!guarded.ok) {
      return guarded.response;
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      return body.response;
    }
    const parsed = parseBody(body.body);
    if (parsed === null) {
      return NextResponse.json(
        { success: false, error: 'confirmExisting moet true of false zijn' },
        { status: 400 }
      );
    }

    const scope = await requireAgendaItem(guarded.deps, itemId);
    if (!scope.ok) {
      return scope.response;
    }

    const { monday, mutate, checklists, boardId } = guarded.deps;
    const site = siteConfigFromEnv();
    const graphConfig = graphConfigFromEnv();
    const graph = createGraphClient(graphConfig, { signal: afbreken.signal });
    /**
     * Een tweede client, met zijn eigen ruimere klok.
     *
     * Alleen voor het herstel ná een afgebroken upload. Zou dat herstel op dezelfde client
     * lopen, dan sneuvelt het precies wanneer het nodig is — het signaal dat de upload
     * afkapte laat de herstelvraag er immers ook meteen in blijven.
     */
    const herstel = createGraphClient(graphConfig, { signal: herstelAfbreken.signal });
    const store = createSharePointStore(graph, await resolveSiteId(graph, site), herstel);

    const uit = await runGenerate(
      {
        readTraining: () => readBriefingTraining(monday, itemId, { boardId }),
        readChecklist: () => checklists.read(itemId),
        store,
        site,
        buildContext: (training, invoer) => buildGenerateContext(monday, training, invoer),
        recorder: createBriefingRecorder(mutate, boardId),
        // De Nederlandse kalenderdag: `toISOString` geeft de UTC-datum, en dan staat er
        // tussen middernacht en 01:00 (winter) of 02:00 (zomer) gisteren in Monday.
        today: () => amsterdamToday(new Date()),
        remainingMs: () => deadline - Date.now(),
      },
      {
        itemId,
        confirmExisting: parsed.confirmExisting === true,
        planToken: parsed.planToken,
      }
    );

    switch (uit.kind) {
      case 'planned':
        return NextResponse.json({ success: true, data: uit.plan });

      case 'changed':
        log.info('briefing: plan of invoer gewijzigd', { itemId, reden: uit.plan.changed });
        return NextResponse.json(
          { success: false, error: uit.message, data: uit.plan },
          { status: 409 }
        );

      case 'blocked':
        return NextResponse.json(
          {
            success: false,
            error: uit.message,
            ...(uit.issues.length > 0 ? { issues: uit.issues } : {}),
          },
          { status: 409 }
        );

      case 'refused':
        return NextResponse.json({ success: false, error: uit.message }, { status: 409 });

      case 'no_time':
        log.warn('briefing: te weinig tijd over om te schrijven', { itemId });
        return NextResponse.json({ success: false, error: uit.message }, { status: 503 });

      case 'written':
        log.info('briefing gegenereerd', {
          itemId,
          volledig: !uit.partial,
          documenten: uit.documents.length,
          versies: uit.documents.filter((d) => d.versioned).length,
          brie: uit.brie,
          administratieProblemen: uit.administratie.length,
        });
        return NextResponse.json({
          success: true,
          data: {
            stage: 'written',
            partial: uit.partial,
            failure: uit.failure,
            documents: uit.documents,
            notes: uit.notes,
            // Leeg is goed nieuws; anders staan de documenten er wél en klopt de
            // administratie niet.
            administratie: uit.administratie,
            brie: uit.brie,
          },
        });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('briefing genereren mislukt', { itemId, message });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    // Anders houden de openstaande timers de functie in leven tot ze aflopen.
    clearTimeout(timer);
    clearTimeout(herstelTimer);
  }
}
