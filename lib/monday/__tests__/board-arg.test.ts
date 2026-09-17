import { describe, expect, it } from 'vitest';

import { boardFromArgv } from '../board-arg';

describe('boardFromArgv', () => {
  it('leest het bord na --board', () => {
    expect(boardFromArgv(['--board', '6000000001', '--apply'])).toBe('6000000001');
  });

  it('geeft null zonder de vlag, zodat het script zijn standaard kiest', () => {
    expect(boardFromArgv(['--apply'])).toBeNull();
  });

  it('weigert een ontbrekende of rare waarde in plaats van het verkeerde bord te kiezen', () => {
    expect(() => boardFromArgv(['--board'])).toThrow(/bord-id/);
    expect(() => boardFromArgv(['--board', '--apply'])).toThrow(/bord-id/);
  });
});
