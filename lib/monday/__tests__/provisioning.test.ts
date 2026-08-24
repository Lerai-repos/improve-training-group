import { describe, expect, it } from 'vitest';

import {
  agendaOverrideVerdict,
  checkColumn,
  IDEMPOTENCY_WINDOW_MS,
  relationBoardIds,
  sampleCleanupPlan,
  statusLabels,
  unresolvedCreateVerdict,
} from '../provisioning';

/**
 * De beslissingen die een provisioning-script neemt vóórdat het iets onomkeerbaars doet.
 *
 * Ze staan hier en niet in `scripts/` omdat daar niets wordt uitgevoerd: de testconfiguratie
 * kijkt alleen naar `lib/**` en `components/**`. Een script dat live borden aanmaakt en rijen
 * verwijdert is precies het soort code dat wél dekking hoort te hebben, dus het oordeel zit
 * hier en het script is de aanroeper.
 */

describe('relationBoardIds', () => {
  /**
   * Monday geeft bord-ids in `settings_str` terug als GETAL, terwijl wij ze overal als string
   * hanteren. Een vergelijking zonder normalisatie leest als "wijst naar een ander bord" en
   * zou een correcte kolom afkeuren.
   */
  it('leest bord-ids als string, ook als Monday getallen stuurt', () => {
    expect(relationBoardIds('{"boardIds":[5087396949]}')).toEqual(['5087396949']);
    expect(relationBoardIds('{"boardIds":["5087396949"]}')).toEqual(['5087396949']);
  });

  it('geeft null bij instellingen die niet te lezen zijn', () => {
    expect(relationBoardIds(null)).toBeNull();
    expect(relationBoardIds('')).toBeNull();
    expect(relationBoardIds('niet-json')).toBeNull();
    expect(relationBoardIds('{"boardIds":"5087396949"}')).toBeNull();
  });
});

describe('statusLabels', () => {
  it('leest de labels ongeacht of de sleutel een getal of een string is', () => {
    expect(statusLabels('{"labels":{"1":"Leadtrainer","2":"Co-trainer"}}')).toEqual([
      'Co-trainer',
      'Leadtrainer',
    ]);
  });

  it('geeft null bij instellingen die niet te lezen zijn', () => {
    expect(statusLabels('{}')).toBeNull();
    expect(statusLabels(null)).toBeNull();
  });
});

describe('checkColumn', () => {
  const relation = {
    id: 'itg_training',
    type: 'board_relation',
    relationBoardIds: ['5087396949'],
  } as const;

  it('keurt een relatie goed die naar het verwachte bord wijst', () => {
    expect(
      checkColumn(relation, { type: 'board_relation', settings_str: '{"boardIds":[5087396949]}' })
    ).toEqual({ kind: 'ok' });
  });

  /**
   * Het gat dat dit dicht: een kolom met het juiste TYPE werd als correct gemeld, ook als hij
   * naar een heel ander bord wees. Hij staat er dan, hij is leeg, en niemand merkt het.
   */
  it('wijst een relatie af die naar een ander bord wijst', () => {
    expect(
      checkColumn(relation, { type: 'board_relation', settings_str: '{"boardIds":[1311331281]}' })
    ).toEqual({ kind: 'wrong_relation', found: ['1311331281'], expected: ['5087396949'] });
  });

  /**
   * De deelverzameling-val: `[verwacht, iets anders]` bevat het verwachte bord en kwam er
   * dus doorheen als "klopt". De runtime-controle is strenger — `assertColumns` zoekt de
   * letterlijke tekst `"boardIds":[5087396949]`, en die staat niet in
   * `"boardIds":[5087396949,999]`. Zo meldde dit script een bord als goed terwijl de motor
   * het even later weigerde.
   */
  it('wijst een relatie af die ook naar een ONVERWACHT bord wijst', () => {
    expect(
      checkColumn(relation, {
        type: 'board_relation',
        settings_str: '{"boardIds":[5087396949,999]}',
      })
    ).toEqual({ kind: 'wrong_relation', found: ['5087396949', '999'], expected: ['5087396949'] });
  });

  it('accepteert dezelfde borden in een andere volgorde', () => {
    const twee = { ...relation, relationBoardIds: ['5087396949', '999'] } as const;
    expect(
      checkColumn(twee, { type: 'board_relation', settings_str: '{"boardIds":[999,5087396949]}' })
    ).toEqual({ kind: 'ok' });
  });

  it('wijst een kolom met het verkeerde type af vóór de instellingen', () => {
    expect(checkColumn(relation, { type: 'text', settings_str: null })).toEqual({
      kind: 'wrong_type',
      found: 'text',
    });
  });

  /**
   * Onleesbaar is niet hetzelfde als fout, en mag zeker niet als goed doorgaan: dan is
   * "Monday stuurde iets anders" niet te onderscheiden van "de kolom klopt".
   */
  it('meldt onleesbare instellingen apart', () => {
    expect(checkColumn(relation, { type: 'board_relation', settings_str: '{}' })).toEqual({
      kind: 'unreadable_settings',
    });
  });

  it('controleert de labels van een statuskolom', () => {
    const rol = {
      id: 'itg_rol',
      type: 'status',
      statusLabels: ['Leadtrainer', 'Co-trainer', 'Trainingsacteur'],
    } as const;

    expect(
      checkColumn(rol, {
        type: 'status',
        settings_str: '{"labels":{"1":"Leadtrainer","2":"Co-trainer","3":"Trainingsacteur"}}',
      })
    ).toEqual({ kind: 'ok' });
    expect(
      checkColumn(rol, { type: 'status', settings_str: '{"labels":{"1":"Leadtrainer"}}' })
    ).toEqual({ kind: 'wrong_labels', missing: ['Co-trainer', 'Trainingsacteur'] });
  });

  /** Zonder verwachting over de instellingen is het type het enige dat telt. */
  it('kijkt alleen naar het type wanneer er niets over instellingen is afgesproken', () => {
    expect(checkColumn({ id: 'itg_ontvanger', type: 'text' }, { type: 'text' })).toEqual({
      kind: 'ok',
    });
  });
});

describe('sampleCleanupPlan', () => {
  const OURS = ['itg_training', 'itg_rol'];

  /**
   * DE regressie waar dit voor bestaat. Zonder vastgelegde ids leidde "ruim de voorbeelden op"
   * tot "verwijder alles wat op het bord staat" — en zodra het register echte briefingregels
   * bevat, wist een herstelrun tot 50 productierijen.
   */
  it('verwijdert alleen de vastgelegde voorbeelditems', () => {
    const plan = sampleCleanupPlan(
      { phase: 'captured', itemIds: ['1', '2'], groupIds: ['g1'] },
      { columnIds: [...OURS, 'itg_klant'] },
      OURS
    );
    expect(plan).toEqual({ kind: 'delete', itemIds: ['1', '2'], groupIds: ['g1'] });
  });

  it('doet niets meer als het opruimen al is afgerond', () => {
    expect(sampleCleanupPlan({ phase: 'cleared' }, { columnIds: OURS }, OURS)).toEqual({
      kind: 'done',
    });
  });

  /**
   * Een bord waarop onze kolommen al staan, is voorbij het voorbeeldstadium — het opruimen is
   * gebeurd, we hebben het alleen nooit genoteerd. Blind opnieuw vastleggen zou hier élke rij
   * van het register als "voorbeeld" markeren.
   */
  it('gaat ervan uit dat het opruimen al gebeurd is zodra onze kolommen bestaan', () => {
    expect(
      sampleCleanupPlan({ phase: 'uncaptured' }, { columnIds: ['itg_training'] }, OURS)
    ).toEqual({ kind: 'already_done' });
  });

  /** Niets van ons op het bord: alles wat er staat is van Monday, en dus veilig vast te leggen. */
  it('legt de voorbeelden vast op een bord waar nog niets van ons staat', () => {
    expect(sampleCleanupPlan({ phase: 'uncaptured' }, { columnIds: ['name'] }, OURS)).toEqual({
      kind: 'capture',
    });
  });
});

describe('unresolvedCreateVerdict', () => {
  const startedAt = 1_000_000;

  it('laat een hervatting binnen het venster de sleutel hergebruiken', () => {
    expect(unresolvedCreateVerdict(startedAt, startedAt + IDEMPOTENCY_WINDOW_MS - 1)).toEqual({
      kind: 'retry',
    });
  });

  /**
   * Voorbij het venster beschermt de sleutel niets meer en is er geen bord-id om op te
   * hervatten. Opnieuw versturen zou een TWEEDE bord kunnen maken waar niets naar wijst — een
   * mens moet dan eerst kijken.
   */
  it('weigert opnieuw te versturen zodra het venster verlopen is', () => {
    const verdict = unresolvedCreateVerdict(startedAt, startedAt + IDEMPOTENCY_WINDOW_MS + 1);
    expect(verdict.kind).toBe('refuse');
  });
});

describe('agendaOverrideVerdict', () => {
  const PRODUCTION = '5087396949';

  /**
   * `MONDAY_AGENDA_BOARD_ID` richt de hele pijplijn op een KOPIE van Agenda 2026. Een bord dat
   * permanent naar die kopie wijst, en waarvan het id in de code wordt gezet, is niet te
   * herstellen door de override later weg te halen.
   */
  it('weigert --apply zolang de agenda-override aanstaat', () => {
    const verdict = agendaOverrideVerdict({
      configured: '5101664426',
      production: PRODUCTION,
      apply: true,
      allowOverride: false,
    });
    expect(verdict.kind).toBe('refuse');
  });

  it('laat een droogloop wel door, want die maakt niets aan', () => {
    expect(
      agendaOverrideVerdict({
        configured: '5101664426',
        production: PRODUCTION,
        apply: false,
        allowOverride: false,
      })
    ).toEqual({ kind: 'ok' });
  });

  it('laat het bewust doorgaan als de operator er expliciet om vraagt', () => {
    expect(
      agendaOverrideVerdict({
        configured: '5101664426',
        production: PRODUCTION,
        apply: true,
        allowOverride: true,
      })
    ).toEqual({ kind: 'ok' });
  });

  /** Leeg valt terug op productie — `agendaBoardId()` gebruikt `||`, niet `??`. */
  it('leest een lege of ontbrekende override als geen override', () => {
    for (const configured of [undefined, '', '   ']) {
      expect(
        agendaOverrideVerdict({ configured, production: PRODUCTION, apply: true, allowOverride: false })
      ).toEqual({ kind: 'ok' });
    }
  });

  it('zwijgt wanneer de override juist naar productie wijst', () => {
    expect(
      agendaOverrideVerdict({
        configured: PRODUCTION,
        production: PRODUCTION,
        apply: true,
        allowOverride: false,
      })
    ).toEqual({ kind: 'ok' });
  });
});
