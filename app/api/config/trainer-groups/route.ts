import { NextResponse } from 'next/server';

import { getAppConfig } from '@lib/config';
import { createAdminSupabaseClient } from '@lib/db/admin';
import { log } from '@lib/logger';
import { MONDAY_API_VERSION, TRAINERS_BOARD } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import {
  authorizeBearer,
  buildTrainerGroupReport,
  currentDeadlineMs,
  runWithDeadline,
  snapshotMaxAgeMs,
  SnapshotUnavailableError,
  unusableSelections,
} from '@lib/recommend';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Absolute deadline for the live Monday call; leaves headroom under maxDuration.
const DEADLINE_MS = 45_000;
const SNAPSHOT_UNAVAILABLE = 503;

/**
 * GET /api/config/trainer-groups — INTERNAL OPERATIONS endpoint.
 *
 * Lists every trainer group with a readiness verdict, so a selection can be checked
 * before it is made. Guarded by `CONFIG_API_SECRET`: `/api` is excluded from the
 * middleware auth, so this route self-authenticates. A browser UI cannot hold that
 * secret — the Monday iframe view will need its own session-authenticated route,
 * specced together with that view.
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

  const admin = createAdminSupabaseClient();

  try {
    // Bound the live Monday read: its own client would otherwise retry 5 × 30s plus
    // an uncapped Retry-After, outliving this route.
    const report = await runWithDeadline(Date.now() + DEADLINE_MS, async () => {
      const cfg = await getAppConfig(admin);
      const client = createMondayGraphQLClient({
        token,
        apiVersion: MONDAY_API_VERSION,
        deadlineMs: currentDeadlineMs,
      });
      return buildTrainerGroupReport({
        admin,
        reader: client,
        trainersBoardId: TRAINERS_BOARD,
        selected: cfg.recommendableTrainerGroups,
        maxAgeMs: snapshotMaxAgeMs(),
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
      syncRunId: report.syncRunId,
      syncStartedAt: report.syncStartedAt,
      refDate: report.refDate,
    });
  } catch (error) {
    // Never answer with a partial/empty list — that would read as "no groups".
    const message = error instanceof Error ? error.message : String(error);
    log.error('trainer-groups readiness failed', { error: message });
    // Classify on the ERROR TYPE, not on the message text: a Zod failure on the RPC
    // result mentions `sync_run_id` in its path, and string-matching would report a
    // schema/deploy defect as "stale snapshot" — sending the operator to re-run a
    // sync that can never fix it.
    if (error instanceof SnapshotUnavailableError) {
      return NextResponse.json(
        { success: false, error: message, issue: error.issue.kind },
        { status: SNAPSHOT_UNAVAILABLE }
      );
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
