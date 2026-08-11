import { NextResponse } from 'next/server';

import {
  BOARD_LOOKUP_DEADLINE_MS,
  handleWhatsappDiscard,
  handleWhatsappGet,
  handleWhatsappSave,
  runWithDeadline,
} from '@lib/recommend';

import { guard, readJsonBody } from '../guard';

export const runtime = 'nodejs';

/**
 * The WhatsApp availability message for one training — generated, edited, discarded.
 *
 * **`plan`, not `view`.** The main envelope is account-wide and does not verify Agenda
 * board access; this payload carries klant, locatie, deelnemersaantal and whatever a
 * planner typed. It introduces no new boundary — `PUT approached` already writes
 * account-wide shared state keyed only by item id — but it does narrow who sees free
 * text. See the access policy in `docs/m2b/README.md`.
 *
 * **Never polled.** The panel calls this when it opens, on save, and on revert. That is
 * what makes the Monday read here affordable, unlike on the every-few-seconds GET.
 */

/**
 * ONE absolute deadline per request, captured here.
 *
 * `createMondayGraphQLClient` is wired with `deadlineMs: currentDeadlineMs`, which is
 * `null` outside a `runWithDeadline` scope — so without this wrapper the client's retry
 * budget is unbounded and a Monday outage would hang a save through five 30-second
 * attempts. Absolute, not relative: a `() => Date.now() + n` callback grants a fresh
 * budget on every attempt, which is a renewal, not a deadline.
 */
function bounded<T>(work: () => Promise<T>): Promise<T> {
  return runWithDeadline(Date.now() + BOARD_LOOKUP_DEADLINE_MS, work);
}

function failed(method: string, error: unknown): NextResponse {
  // The detail goes to the log, never to the caller: Redis and Monday exception text
  // carries hostnames, key names and query fragments.
  console.error(
    `${method} /api/recommendations/[itemId]/whatsapp failed`,
    error instanceof Error ? error.stack : String(error)
  );
  return NextResponse.json({ success: false, error: 'internal error' }, { status: 500 });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  try {
    const { itemId } = await params;

    const allowed = await guard(request, 'plan');
    if (!allowed.ok) {
      return allowed.response;
    }

    const result = await bounded(() => handleWhatsappGet(allowed.deps.whatsapp(), itemId));
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return failed('GET', error);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  try {
    const { itemId } = await params;

    const allowed = await guard(request, 'plan');
    if (!allowed.ok) {
      return allowed.response;
    }

    const json = await readJsonBody(request);
    if (!json.ok) {
      return json.response;
    }

    const result = await bounded(() =>
      handleWhatsappSave(allowed.deps.whatsapp(), itemId, json.body)
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return failed('PUT', error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  try {
    const { itemId } = await params;

    const allowed = await guard(request, 'plan');
    if (!allowed.ok) {
      return allowed.response;
    }

    const json = await readJsonBody(request);
    if (!json.ok) {
      return json.response;
    }

    const result = await bounded(() =>
      handleWhatsappDiscard(allowed.deps.whatsapp(), itemId, json.body)
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return failed('DELETE', error);
  }
}
