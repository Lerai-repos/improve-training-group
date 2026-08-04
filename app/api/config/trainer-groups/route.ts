import { NextResponse } from 'next/server';

import { log } from '@lib/logger';
import {
  ITEM_FIELDS,
  MONDAY_API_VERSION,
  THEMAS_BOARD,
  TRAINERS_BOARD,
} from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import {
  authorizeBearer,
  ACKNOWLEDGEMENTS,
  buildEngineConfig,
  buildTrainerGroupReport,
  createMondayReader,
  currentDeadlineMs,
  readAllEffectiveQuals,
  readRoster,
  runWithDeadline,
  unusableSelections,
} from '@lib/recommend';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Absolute deadline for the live Monday calls; leaves headroom under maxDuration.
const DEADLINE_MS = 45_000;

/**
 * GET /api/config/trainer-groups — INTERNAL OPERATIONS endpoint.
 *
 * Lists every trainer group with a readiness verdict, so a selection can be checked
 * before it is made. Guarded by `CONFIG_API_SECRET`: `/api` self-authenticates. A
 * browser UI cannot hold that secret — the Monday iframe view will need its own
 * session-authenticated route, specced together with that view.
 *
 * Everything is read live, so there is no snapshot to be stale: the 503
 * "snapshot unavailable" branch this route used to carry is gone with it.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorizeBearer(request.headers.get('authorization'), process.env.CONFIG_API_SECRET)) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    return NextResponse.json(
      { success: false, error: 'MONDAY_API_TOKEN is not configured' },
      { status: 500 }
    );
  }

  try {
    // Bound the live Monday reads: the client would otherwise retry 5 × 30s plus an
    // uncapped Retry-After, outliving this route.
    const report = await runWithDeadline(Date.now() + DEADLINE_MS, async () => {
      const config = buildEngineConfig();
      const client = createMondayGraphQLClient({
        token,
        apiVersion: MONDAY_API_VERSION,
        deadlineMs: currentDeadlineMs,
      });
      const reader = createMondayReader(client);
      // One schema call for both boards. The METADATA is forwarded, not a bare
      // count: the adapters validate whatever they are given, so this cannot skip
      // the check.
      const meta = await client.getSchema([TRAINERS_BOARD, THEMAS_BOARD]);
      const metaOf = (id: string) => meta.find((b) => String(b.id) === id);

      const [roster, effective] = await Promise.all([
        readRoster(client, ITEM_FIELDS, metaOf(TRAINERS_BOARD)),
        readAllEffectiveQuals(client, ACKNOWLEDGEMENTS, metaOf(THEMAS_BOARD)),
      ]);
      return buildTrainerGroupReport({
        reader: client,
        trainersBoardId: TRAINERS_BOARD,
        roster,
        effective,
        rateCards: config.rateCards,
        selected: config.recommendableGroups,
      });
    });

    return NextResponse.json({
      success: true,
      data: report.rows,
      selected: report.selected,
      unusableSelections: unusableSelections(report.rows).map((r) => ({
        id: r.id,
        status: r.status,
      })),
      refDate: report.refDate,
    });
  } catch (error) {
    // Never answer with a partial/empty list — that would read as "no groups".
    const message = error instanceof Error ? error.message : String(error);
    log.error('trainer-groups readiness failed', { error: message });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
