import { NextResponse } from 'next/server';

import { z } from 'zod';

import { readCyclusKandidaten } from '@lib/briefing/cyclus-read';
import { bevestigCyclus } from '@lib/briefing/cyclus-confirm';
import { readBriefingTraining } from '@lib/briefing/read';
import { loadAgendaBoards } from '@lib/evaluations';

import { guard, readJsonBody, requireAgendaItem } from '../guard';

/**
 * PUT /api/briefing/[itemId]/cyclus — welke sessies samen één briefing krijgen.
 *
 * De regel stelt voor, de adviseur bevestigt (Tim, 18-Sep-2026). Het antwoord wordt bij de
 * **Opportunity** bewaard en niet bij deze sessie: onder één opdracht kunnen meerdere cycli
 * staan, en het antwoord moet blijven gelden als de regel later iets anders zou vinden.
 *
 * Een lege lijst is een geldig antwoord en betekent "dit is geen cyclus". Dat wordt vastgelegd,
 * zodat de vraag niet elke keer terugkomt.
 *
 * `plan` en niet `view`: dit bepaalt hoeveel documenten er straks uit komen en voor wie.
 */

const bodySchema = z.object({
  itemIds: z.array(z.string().min(1)).max(50),
  /** Wat er op het scherm stond; alleen dat geldt als beoordeeld. */
  getoond: z.array(z.string().min(1)).max(50),
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
    return NextResponse.json(
      { success: false, error: 'itemIds en getoond moeten lijsten met item-ids zijn' },
      { status: 400 }
    );
  }

  const scope = await requireAgendaItem(guarded.deps, itemId);
  if (!scope.ok) {
    return scope.response;
  }

  try {
    const { monday, checklists, cycli } = guarded.deps;
    const uit = await bevestigCyclus(
      {
        readTraining: () =>
          readBriefingTraining(monday, itemId, {
            boardId: scope.boardId,
            relations: scope.relations,
          }),
        readKandidaten: async (training) =>
          await readCyclusKandidaten(
            monday,
            training.opportunityItemId,
            (await loadAgendaBoards(monday)).boards
          ),
        cycli,
        checklists,
      },
      {
        itemId,
        /**
         * Een lege lijst blijft leeg: dat is het antwoord "geen cyclus". Kiest de adviseur wél
         * sessies, dan hoort deze training er hoe dan ook bij — het vinkje staat op het scherm
         * vast, dus meesturen is niet iets waar de client zich in kan vergissen.
         */
        gekozen:
          parsed.data.itemIds.length === 0
            ? []
            : [...new Set([...parsed.data.itemIds, itemId])],
        getoond: [...new Set([...parsed.data.getoond, itemId])],
      }
    );
    if (uit.kind === 'geweigerd') {
      return NextResponse.json({ success: false, error: uit.message }, { status: CONFLICT });
    }
    return NextResponse.json({
      success: true,
      data: { cyclus: uit.training.cyclus, cyclusKeuze: uit.training.cyclusKeuze },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('briefing: cyclus bevestigen mislukt', { itemId, message });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
