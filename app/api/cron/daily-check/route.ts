import { NextResponse } from 'next/server';

import { log } from '@lib/logger';
import { authorizeBearer, currentDeadlineMs, runWithDeadline } from '@lib/recommend';
import {
  buildDailyCheckDeps,
  buildSignalLease,
  runDailyCheckExclusive,
  signalGroups,
  systeemBoardId,
} from '@lib/signals';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';

export const runtime = 'nodejs';
/**
 * Twee agendaborden volledig doorbladeren plus het Thema's-, Labels- en Systeem-bord. Ruim
 * genomen: `fetchBoardItems` leest élke pagina twee keer om de pull op coherentie te toetsen.
 */
export const maxDuration = 300;
const RUN_DEADLINE_MS = 260_000;

/**
 * GET /api/cron/daily-check — de dagelijkse controle.
 *
 * Gepland op 03:15 UTC (`vercel.json`): ná `eval-stats` van 02:45, zodat de twee elkaars
 * Monday-budget niet in de weg zitten, en ruim vóór de werkdag begint.
 *
 * `?dryRun=1` leest en berekent alles zonder te schrijven.
 *
 * Deze job SCHRIJFT ALLEEN NAAR HET SYSTEEM-BORD. Hij raakt de agenda, het Labels-bord en het
 * Thema's-bord niet aan — dat is de afspraak uit `02-datamodel-monday.md`: een controle, geen
 * reparatie.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorizeBearer(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  // Fail closed: alleen de letterlijke '1' telt als droogloop.
  const dryRun = url.searchParams.get('dryRun') === '1';

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    return NextResponse.json(
      { ok: false, error: 'MONDAY_API_TOKEN is not configured' },
      { status: 500 }
    );
  }

  const started = Date.now();
  try {
    const outcome = await runWithDeadline(started + RUN_DEADLINE_MS, async () => {
      const client = createMondayGraphQLClient({
        token,
        apiVersion: MONDAY_API_VERSION,
        deadlineMs: currentDeadlineMs,
      });
      const boardId = systeemBoardId();
      const groups = await signalGroups(client, boardId);
      const { deps } = buildDailyCheckDeps({ dryRun, groups, deadlineMs: currentDeadlineMs });
      return runDailyCheckExclusive(deps, buildSignalLease(), boardId);
    });

    const durationMs = Date.now() - started;

    /**
     * Een 200, geen fout.
     *
     * Er is niets misgegaan: een andere run had de grendel en doet exact hetzelfde werk. Dit
     * als 500 melden zou een alarm opleveren voor een systeem dat zich precies zo gedraagt als
     * bedoeld.
     */
    if (outcome.kind === 'busy') {
      log.info('daily-check skipped', { reason: 'lease_held', durationMs });
      return NextResponse.json({ ok: true, skipped: 'andere_run_bezig', durationMs });
    }
    const report = outcome.report;

    /**
     * Een mislukte deelcontrole is een 500, net als bij `eval-stats`.
     *
     * De run heeft dan wél gedaan wat hij kon — de andere controle is gewoon gedraaid en zijn
     * meldingen staan er — maar er is een gat waar niemand iets van weet. Een job die daarop
     * 200 teruggeeft is een job die niemand in de gaten houdt.
     */
    if (report.failures.length > 0) {
      log.error('daily-check partial', { failures: report.failures, durationMs });
      return NextResponse.json({ ok: false, durationMs, ...report }, { status: 500 });
    }

    log.info('daily-check done', {
      dryRun: report.dryRun,
      findings: report.findings.length,
      created: report.created,
      updated: report.updated,
      reopened: report.reopened,
      resolved: report.resolved,
      moved: report.moved,
      trainingen: report.trainingen,
      durationMs,
    });

    return NextResponse.json({ ok: true, durationMs, ...report });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('daily-check failed', { error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
