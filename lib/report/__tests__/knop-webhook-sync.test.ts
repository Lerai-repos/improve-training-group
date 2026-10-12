import { describe, expect, it } from 'vitest';

import { teVerwijderen } from '../knop-webhook-sync';

/** Zo geeft Monday `config` terug: een Ruby-hash als tekst. Gemeten op Agenda 2026. */
const N8N = {
  id: '157401136',
  event: 'change_status_column_value',
  config:
    '{"columnId" => {"boardId" => 5087396949, "columnId" => "color_mm0v53mp", "columnType" => ' +
    '"color", "isSubitemColumn" => false}, "columnValue" => {"index" => 1}}',
};
const TRAINER_STATUS = {
  id: '154679354',
  event: 'change_status_column_value',
  config:
    '{"columnId" => {"boardId" => 5087396949, "columnId" => "color_mm088qpd", "columnType" => ' +
    '"color", "isSubitemColumn" => false}, "columnValue" => {"index" => 1}}',
};
const GROEP = { id: '181756731', event: 'item_moved_to_specific_group', config: null };

describe('teVerwijderen', () => {
  it('haalt de oude Eval Status-webhook weg en laat de nieuwe staan', () => {
    const nieuw = { ...N8N, id: '999' };
    expect(teVerwijderen([N8N, nieuw, TRAINER_STATUS, GROEP], '999')).toEqual(['157401136']);
  });

  /** Andere webhooks op het bord zijn van Make.com of van onze aanbevelingen: niet aankomen. */
  it('raakt webhooks op andere kolommen en events niet aan', () => {
    expect(teVerwijderen([TRAINER_STATUS, GROEP], '999')).toEqual([]);
  });

  it('herkent een webhook zonder config niet als Eval Status', () => {
    expect(teVerwijderen([{ ...N8N, config: null }], '999')).toEqual([]);
  });
});
