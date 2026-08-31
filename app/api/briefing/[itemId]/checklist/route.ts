import { NextResponse } from 'next/server';

import { z } from 'zod';

import { CONCEPT_MAX_LENGTH, validateChecklist } from '@lib/briefing/checklist-store';

import { guard, readJsonBody, requireAgendaItem } from '../guard';

/**
 * De antwoorden van de adviseur opslaan.
 *
 * `PUT` en geen `PATCH`: het scherm stuurt altijd de hele checklist, want de vinkjes hangen
 * samen — "ieder een eigen groep" en "samen op één groep" zijn twee antwoorden op dezelfde
 * vraag, en die los kunnen zetten laat een combinatie ontstaan die nergens meer uit komt.
 *
 * Het `token` moet mee. Klopt het niet meer, dan heeft iemand anders — of hetzelfde tabblad
 * in een ander venster — intussen opgeslagen, en krijgt de aanroeper een 409 mét de huidige
 * stand terug in plaats van er stilzwijgend overheen te schrijven.
 */

const bodySchema = z.object({
  checklist: z.object({
    ownGroup: z.boolean(),
    sameGroup: z.boolean(),
    trainingCycle: z.boolean(),
    homework: z.boolean(),
    preparatoryAssignment: z.boolean(),
    trainingActor: z.boolean(),
    conceptInhoud: z.string().max(CONCEPT_MAX_LENGTH).optional(),
  }),
  actorItemIds: z.array(z.string().min(1)).max(50),
  actorAnswered: z.boolean(),
  token: z.string().min(1),
});

const CONFLICT = 409;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  const { itemId } = await params;
  const guarded = await guard(request, 'plan');
  if (!guarded.ok) {
    return guarded.response;
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }

  const parsed = bodySchema.safeParse(body.body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'ongeldige checklist' }, { status: 400 });
  }

  const input = {
    checklist: parsed.data.checklist,
    actorItemIds: parsed.data.actorItemIds,
    actorAnswered: parsed.data.actorAnswered,
  };
  const invalid = validateChecklist(input);
  if (invalid !== null) {
    return NextResponse.json({ success: false, error: invalid }, { status: 400 });
  }

  /**
   * De bordcontrole staat ná het valideren en vóór de store.
   *
   * Ná het valideren, omdat een afgekeurde body niets aanraakt en de aanroeper dan een
   * bruikbare 400 hoort te krijgen in plaats van een 404 over bereik. Vóór de store, omdat
   * dáár het gevaar zit: het item-id komt uit de URL en is anders een vrij te kiezen sleutel
   * in KV — inclusief het teruglezen van andermans waarde via het botsingsantwoord.
   */
  const scope = await requireAgendaItem(guarded.deps, itemId);
  if (!scope.ok) {
    return scope.response;
  }

  try {
    const uit = await guarded.deps.checklists.save(itemId, { ...input, token: parsed.data.token });
    if (uit.kind === 'conflict') {
      return NextResponse.json(
        {
          success: false,
          error: 'iemand anders heeft deze checklist intussen opgeslagen',
          data: { saved: uit.saved, token: uit.token, unreadable: uit.unreadable },
        },
        { status: CONFLICT }
      );
    }
    return NextResponse.json({ success: true, data: { saved: uit.saved, token: uit.token } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('briefing: checklist opslaan mislukt', { itemId, message });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
