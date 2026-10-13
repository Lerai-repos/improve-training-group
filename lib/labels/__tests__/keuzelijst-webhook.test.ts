import { describe, expect, it } from 'vitest';

import { parseLabelsWebhook } from '../keuzelijst-webhook';

const BORD = '5103340139';

describe('parseLabelsWebhook', () => {
  it('geeft de challenge terug', () => {
    expect(parseLabelsWebhook({ challenge: 'abc' }, BORD)).toEqual({
      kind: 'challenge',
      challenge: 'abc',
    });
  });

  it.each(['create_pulse', 'create_item', 'change_name', 'update_name', 'update_column_value'])(
    'start een ronde bij %s op het Labels-bord',
    (type) => {
      expect(parseLabelsWebhook({ event: { type, boardId: Number(BORD) } }, BORD)).toEqual({
        kind: 'sync',
      });
    }
  );

  it('negeert een ander bord en een event dat geen label toevoegt', () => {
    expect(parseLabelsWebhook({ event: { type: 'create_pulse', boardId: 1 } }, BORD)).toEqual({
      kind: 'negeren',
      reden: 'ander bord: 1',
    });
    expect(parseLabelsWebhook({ event: { type: 'item_deleted', boardId: BORD } }, BORD)).toEqual({
      kind: 'negeren',
      reden: 'event item_deleted',
    });
    expect(parseLabelsWebhook('x', BORD)).toEqual({ kind: 'negeren', reden: 'geen object' });
  });
});
