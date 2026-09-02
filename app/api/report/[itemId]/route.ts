import { NextResponse } from 'next/server';

import { log } from '@lib/logger';
import { authorizeBearer, currentDeadlineMs, runWithDeadline } from '@lib/recommend';
import { buildReportRunDeps } from '@lib/report/deps';
import { runReport } from '@lib/report/run';

export const runtime = 'nodejs';
/**
 * Ruim: drie Google-documenten, twee agendaborden, het Labels-bord, drie afbeeldingen
 * ophalen en dan Chromium starten. Op een koude instantie kost die laatste stap alleen al
 * bijna drie seconden.
 */
export const maxDuration = 300;
const RUN_DEADLINE_MS = 260_000;

/**
 * GET /api/report/[itemId] — het evaluatierapport van één training, als PDF.
 *
 * OPERATORPAD. `CONFIG_API_SECRET`, dezelfde sleutel als de configuratieroute: dit is
 * gereedschap voor een herdraai, geen Monday-tab, dus het hoort niet achter een
 * sessietoken. Komt er een knop in de app, dan krijgt die zijn eigen sessie-geauthenticeerde
 * route — een browser kan dit geheim niet dragen.
 *
 * De dagjob roept dit NIET over HTTP aan: die leest de agenda van gisteren en gebruikt
 * `runReport` rechtstreeks, zodat de sheets één keer gelezen worden in plaats van per
 * training opnieuw.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  if (!authorizeBearer(request.headers.get('authorization'), process.env.CONFIG_API_SECRET)) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }

  const { itemId } = await params;
  if (!/^\d+$/.test(itemId)) {
    return NextResponse.json(
      { success: false, error: 'itemId moet een Monday-item-id zijn' },
      { status: 400 }
    );
  }

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    return NextResponse.json(
      { success: false, error: 'MONDAY_API_TOKEN is not configured' },
      { status: 500 }
    );
  }

  const started = Date.now();
  try {
    const outcome = await runWithDeadline(started + RUN_DEADLINE_MS, async () =>
      runReport(itemId, buildReportRunDeps(currentDeadlineMs))
    );

    const durationMs = Date.now() - started;

    /**
     * De niet-gelukte uitkomsten zijn 4xx met een reden, geen 500.
     *
     * Het zijn geen storingen maar toestanden van de gegevens: een label zonder
     * configuratie, een training zonder code, een code zonder reacties. Ze als serverfout
     * melden zou de échte fouten onvindbaar maken tussen de ruis.
     */
    switch (outcome.kind) {
      case 'not_found':
        return NextResponse.json(
          { success: false, error: `Agenda-item ${itemId} niet gevonden` },
          { status: 404 }
        );
      case 'unknown_label':
        return NextResponse.json(
          {
            success: false,
            error: `Label "${outcome.training.rawLabel}" heeft geen configuratie op het Labels-bord`,
            reason: 'unknown_label',
          },
          { status: 422 }
        );
      case 'no_code':
        return NextResponse.json(
          {
            success: false,
            error: 'Deze training heeft geen IE-code, dus er is nooit een evaluatie uitgezet',
            reason: 'no_code',
          },
          { status: 422 }
        );
      case 'missing_trainer':
        return NextResponse.json(
          {
            success: false,
            error:
              'Er is geen trainer gekoppeld; de introzin van het rapport noemt de trainer bij naam',
            reason: 'missing_trainer',
          },
          { status: 422 }
        );
      case 'ambiguous_code':
        return NextResponse.json(
          {
            success: false,
            error:
              `De IE-code van deze training wordt ook door een andere klant gebruikt, dus de ` +
              'reacties zijn niet eenduidig toe te wijzen. Er ZIJN reacties — corrigeer de ' +
              'dubbele code op het agendabord.',
            reason: 'ambiguous_code',
          },
          { status: 422 }
        );
      case 'no_responses':
        return NextResponse.json(
          {
            success: false,
            error: 'Geen reacties gevonden op de code van deze training',
            reason: 'no_responses',
          },
          { status: 422 }
        );
      case 'ok':
        break;
    }

    log.info('report generated', {
      itemId,
      label: outcome.label.code,
      responses: outcome.report.responseCount,
      bytes: outcome.report.pdf.byteLength,
      warnings: outcome.report.warnings.length,
      durationMs,
    });

    /**
     * GESTREAMD, niet als één body teruggegeven.
     *
     * Vercel kapt het antwoord van een functie af op **4,5 MB** — *"The maximum payload size
     * for the request body or the response body of a Vercel Function is 4.5 MB"* — met een
     * 413 `FUNCTION_PAYLOAD_TOO_LARGE`. Het FT-rapport is 7,64 MB gemeten, dus dat eindpunt
     * zou voor dat label altijd falen, en de andere acht zitten met ~2,5 MB wel eronder maar
     * niet ruim: genoeg citaten en een rapport groeit er zo doorheen.
     *
     * Vercel's eigen uitweg is streamen: *"Streaming functions don't have this limit."* Het
     * document staat al compleet in het geheugen, dus dit is geen echte stroom maar een
     * gestreamde afgifte van een bestaande buffer — precies genoeg om de grens niet te raken,
     * zonder opslag erbij te halen die het rapport niet nodig heeft.
     *
     * Zonder `Content-Length`, want die kan een gestreamd antwoord niet beloven.
     */
    const pdf = outcome.report.pdf;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pdf);
        controller.close();
      },
    });

    return new NextResponse(body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="evaluatierapport-${itemId}.pdf"`,
        // Zodat een operator ze ziet zonder de logs open te hoeven slaan.
        'X-Report-Responses': String(outcome.report.responseCount),
        'X-Report-Warnings': String(outcome.report.warnings.length),
        'X-Report-Bytes': String(pdf.byteLength),
        'X-Render-Ms': String(durationMs),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('report failed', { itemId, error: message });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
