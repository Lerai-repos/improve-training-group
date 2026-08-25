import { NextResponse } from 'next/server';

import { readBriefingTraining } from '@lib/briefing/read';

import { guard } from './guard';

/**
 * De gegevens waar de tab zijn scherm mee opbouwt.
 *
 * Geeft de **training en de opgeslagen antwoorden** terug, niet het uitgerekende scherm. Dat
 * is met opzet: de tab rekent `buildTabView` zelf uit, zodat het aantal documenten en de
 * blokkades meebewegen zodra de adviseur een vinkje zet. Zou de server een bevroren beeld
 * sturen, dan blijft "0 documenten" staan nadat iemand de acteur heeft aangewezen die precies
 * dat oploste — en pas een herlaadactie zou het rechtzetten.
 *
 * Eén implementatie, twee kanten: dezelfde functie beslist hier en in de browser.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  const { itemId } = await params;
  const guarded = await guard(request, 'view');
  if (!guarded.ok) {
    return guarded.response;
  }

  try {
    const { monday, checklists, boardId } = guarded.deps;
    const training = await readBriefingTraining(monday, itemId, { boardId });

    /**
     * De lezer haalt de training van het ingestelde agendabord, dus een item dat daar niet op
     * staat komt hier niet doorheen. Dat is ook de toegangscontrole op de sleutel in KV: zie
     * `requireAgendaItem` voor het schrijfpad, waar die controle apart nodig is.
     */
    const snapshot = await checklists.read(itemId);

    return NextResponse.json({
      success: true,
      data: {
        training,
        saved: snapshot.saved,
        token: snapshot.token,
        /**
         * Er stáát iets in KV en het is niet te lezen. De tab moet dat kunnen zeggen én het
         * bewerken tegenhouden: een leeg formulier tonen leest als "nog niets ingevuld",
         * terwijl één vinkje er onbekende antwoorden mee zou overschrijven.
         */
        unreadable: snapshot.unreadable,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('briefing: tab lezen mislukt', { itemId, message });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
