import { NextResponse } from 'next/server';

import { amsterdamToday } from '@lib/evaluations';
import { log } from '@lib/logger';
import { authorizeBearer, currentDeadlineMs, runWithDeadline } from '@lib/recommend';
import { amsterdamHour, previousDay, runDailyReports, shouldRunNow } from '@lib/report/daily';
import { buildDailyReportDeps } from '@lib/report/deps';

export const runtime = 'nodejs';
/** Zelfde ruimte als `eval-stats`: drie Google-documenten, twee agendaborden, dan per training een read. */
export const maxDuration = 300;
const RUN_DEADLINE_MS = 260_000;

/**
 * GET /api/cron/eval-reports — de dagelijkse verwerking van gisteren.
 *
 * Om 06:30 Amsterdamse tijd, hetzelfde moment als legacy Flow 9, zodat beide naast elkaar
 * kunnen draaien en vergeleken worden zolang ze allebei bestaan.
 *
 * **Daarom staan er twee cron-regels in `vercel.json`.** Vercel leest cron-expressies altijd
 * in UTC; Amsterdam schuift met de zomertijd, dus één expressie klopt maar de helft van het
 * jaar. `30 4` en `30 5` UTC leveren samen het hele jaar precies één aanroep op 06:30
 * Amsterdam op, en `shouldRunNow` laat de andere meteen weer gaan.
 *
 * De job werkt het bord bij — cijfer, aantal respondenten, en `Onvindbaar` bij een sessie
 * zonder reacties — en stuurt per training twee mails naar ITG's gedeelde postbussen. Dat
 * `Onvindbaar` is de deliverable *"signaal bij ontbrekende respons"* uit de ondertekende
 * scope, in februari gevraagd en nooit gebouwd.
 *
 * `?dryRun=1` bepaalt alles, schrijft niets en verstuurt niets. `?date=YYYY-MM-DD` verwerkt
 * een andere dag, voor een herstelrun; de grendel in `lib/mail/sent-store.ts` zorgt dat zo'n
 * herstelrun geen mail dubbel stuurt. `?noMail=1` doet alleen de bordkant.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorizeBearer(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  // Fail closed: alles behalve de letterlijke '1' is false.
  const dryRun = url.searchParams.get('dryRun') === '1';
  const noMail = url.searchParams.get('noMail') === '1';
  const requested = url.searchParams.get('date');
  if (requested !== null && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    return NextResponse.json({ ok: false, error: 'date moet YYYY-MM-DD zijn' }, { status: 400 });
  }

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: 'MONDAY_API_TOKEN is not configured' },
      { status: 500 }
    );
  }

  /**
   * "Gisteren" in Amsterdamse tijd, niet in UTC.
   *
   * De job draait 's ochtends vroeg; op dat moment zijn beide datums gelijk. Maar een
   * herstelrun kan om elk uur worden gestart, en dan is de UTC-datum tussen middernacht en
   * 02:00 een dag te vroeg — precies de trainingen van gisteravond zouden dan wegvallen.
   */
  const now = new Date();

  /**
   * De grendel geldt alleen voor de GEPLANDE aanroep.
   *
   * Een operator die een dag opnieuw draait geeft `date` mee, en die moet altijd door —
   * anders werkt een herstelrun alleen tussen 06:00 en 07:00. Een droogloop ook.
   */
  if (requested === null && !dryRun && !shouldRunNow(now)) {
    return NextResponse.json({
      ok: true,
      skipped: 'not_the_scheduled_hour',
      amsterdamHour: amsterdamHour(now),
    });
  }

  const date = requested ?? previousDay(amsterdamToday(now));
  const startedMs = Date.now();

  try {
    const { deps } = buildDailyReportDeps({
      date,
      deadlineMs: currentDeadlineMs,
      mail: !noMail,
    });

    const report = await runWithDeadline(startedMs + RUN_DEADLINE_MS, async () =>
      runDailyReports(deps, { date, dryRun })
    );

    const durationMs = Date.now() - startedMs;
    /**
     * Een omleiding is geen detail voor onderaan het logboek.
     *
     * Blijft `ITG_MAIL_KLANT` per ongeluk in productie staan, dan slaagt elke run en gaat
     * elk rapport naar een testadres. Dat hoort te schreeuwen, niet te fluisteren.
     */
    if (report.delivery?.redirected === true) {
      log.warn('eval-reports OMGELEID: mails gingen niet naar de echte postbussen', {
        klant: report.delivery.klant,
        trainer: report.delivery.trainer,
      });
    }

    log.info('eval-reports done', {
      date: report.date,
      considered: report.considered,
      written: report.written,
      mailed: report.mailed,
      mailFailures: report.mailFailures.length,
      delivery: report.delivery,
      warnings: report.lines.flatMap((l) => l.warnings).length,
      dryRun: report.dryRun,
      totals: report.totals,
      durationMs,
    });

    /**
     * Een mislukte mail levert een 500, ook al is de bordkant gelukt.
     *
     * Hetzelfde argument als bij een mislukte run: een dagjob die stilletjes 200 geeft terwijl
     * de accountmanager zijn aftersalesmail niet kreeg, is er een waar niemand naar kijkt. Het
     * bord is dan wél bijgewerkt; de grendel is teruggegeven, dus een herstelrun pakt precies
     * de mislukte mails opnieuw op.
     */
    const status = report.mailFailures.length > 0 ? 500 : 200;
    return NextResponse.json({ ok: status === 200, durationMs, ...report }, { status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('eval-reports failed', { date, error: message });
    // Een 500 zodat Vercel het zichtbaar maakt: een dagjob die stilletjes 200 geeft op een
    // storing is er een waar niemand naar kijkt.
    return NextResponse.json({ ok: false, date, error: message }, { status: 500 });
  }
}
