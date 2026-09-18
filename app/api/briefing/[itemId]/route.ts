import { NextResponse } from 'next/server';

import { ankerMetAntwoorden, raaktDezeCyclus } from '@lib/briefing/cyclus-antwoorden';
import { CyclusDruk, readBriefingMetCyclus } from '@lib/briefing/load';

import { guard, requireAgendaItem } from './guard';

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

  /**
   * Eerst het bord van déze training bepalen en keuren.
   *
   * Er is geen vast agendabord meer: elke actieve jaargang telt. Dit is daarmee ook de
   * toegangscontrole op de sleutel in KV, dezelfde als op het schrijfpad.
   */
  const scope = await requireAgendaItem(guarded.deps, itemId);
  if (!scope.ok) {
    return scope.response;
  }

  try {
    const { monday, checklists, cycli } = guarded.deps;
    /**
     * De lading maakt eerst af wat een vorige bevestiging niet afkreeg en leest dán het
     * cyclusrecord, zodat het hek hieronder bij de stand hoort die nu geldt.
     */
    const { training, fence, geblokkeerd } = await readBriefingMetCyclus(monday, itemId, {
      boardId: scope.boardId,
      relations: scope.relations,
      cycli,
      checklists,
    });
    /**
     * De antwoorden van een trainingscyclus staan onder het anker, zodat de tab op elke sessie
     * hetzelfde toont. Alles wat hier aan de checklist verandert is gehekt op die cyclusstand.
     */
    const anker = await ankerMetAntwoorden(checklists, training, fence);
    if (anker.opnieuw) {
      throw new CyclusDruk();
    }
    const snapshot = await checklists.read(anker.anker);

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
         *
         * Ook als het bij een ánder item van de cyclus staat: een verhuizing die daarop
         * vastloopt levert een leeg anker op, en dat leest net zo goed als "nog niets
         * ingevuld" terwijl er antwoorden zijn die niemand ziet.
         */
        unreadable:
          snapshot.unreadable ||
          anker.geblokkeerd ||
          raaktDezeCyclus(geblokkeerd, training),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('briefing: tab lezen mislukt', { itemId, message });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
