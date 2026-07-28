import { NextResponse } from 'next/server';

import { authorizeCron, buildWorkerDeps, runCronDrain } from '@lib/recommend';

export const runtime = 'nodejs';
export const maxDuration = 300;

// GET /api/cron/recommendations — Vercel Cron drain (Authorization: Bearer $CRON_SECRET).
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorizeCron(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const deps = await buildWorkerDeps();
  const result = await runCronDrain(deps);
  return NextResponse.json({ ok: true, ...result });
}
