import { describe, expect, it, vi } from 'vitest';

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertBoardIdentity,
  cleanupSamples,
  intentFile,
  describeBoardShape,
  provisionFingerprint,
} from '../provision-shell';

import type { ProvisionIntent } from '../provision-shell';

const FINGERPRINT = provisionFingerprint('labels', 'labels-1756000000000');
const EXPECTED = { name: 'Labels', workspaceId: '5308763', fingerprint: FINGERPRINT };

/** Zoals het script hem neerzet: het merkteken staat middenin een leesbare zin. */
const DESCRIPTION = `Labelconfiguratie voor de rapportmotor. Niet weghalen: ${FINGERPRINT}`;

interface IdentityBoard {
  id: string;
  name: string;
  description?: string | null;
  workspace_id?: string | number | null;
}

/** Geen cast nodig: de lezer is concreet getypeerd, dus dit is gewoon het antwoord. */
const readerFor = (board: IdentityBoard | null) => ({
  query: async () => ({ boards: board === null ? [] : [board] }),
});

describe('assertBoardIdentity', () => {
  it('laat het juiste bord door', async () => {
    const read = readerFor({
      id: '1',
      name: 'Labels',
      workspace_id: '5308763',
      description: DESCRIPTION,
    });
    await expect(assertBoardIdentity(read, '1', EXPECTED)).resolves.toBeUndefined();
  });

  /**
   * DE reden dat het merkteken bestaat. Monday staat twee borden "Labels" in één werkruimte
   * toe, dus een oud of afgebroken bord komt door de naam-en-werkruimtecontrole heen — en
   * daarna verwijdert het opruimen zijn eerste vijftig rijen.
   */
  it('weigert een gelijknamig bord in dezelfde werkruimte zonder merkteken', async () => {
    const read = readerFor({
      id: '9',
      name: 'Labels',
      workspace_id: '5308763',
      description: 'Oud bord van vorig jaar',
    });
    await expect(assertBoardIdentity(read, '9', EXPECTED)).rejects.toThrow(FINGERPRINT);
  });

  it('weigert een bord zonder omschrijving', async () => {
    const read = readerFor({ id: '9', name: 'Labels', workspace_id: '5308763' });
    await expect(assertBoardIdentity(read, '9', EXPECTED)).rejects.toThrow('omschrijving');
  });

  /** Het merkteken van een ANDERE poging is net zo goed het verkeerde bord. */
  it('weigert het merkteken van een eerdere run', async () => {
    const read = readerFor({
      id: '9',
      name: 'Labels',
      workspace_id: '5308763',
      description: `Niet weghalen: ${provisionFingerprint('labels', 'labels-1700000000000')}`,
    });
    await expect(assertBoardIdentity(read, '9', EXPECTED)).rejects.toThrow('omschrijving');
  });

  /** En het merkteken van een ander SCRIPT ook, ook al is de run dezelfde. */
  it('weigert het merkteken van een ander script', async () => {
    const read = readerFor({
      id: '9',
      name: 'Labels',
      workspace_id: '5308763',
      description: `Niet weghalen: ${provisionFingerprint('briefings', 'labels-1756000000000')}`,
    });
    await expect(assertBoardIdentity(read, '9', EXPECTED)).rejects.toThrow('omschrijving');
  });

  /**
   * Monday geeft het werkruimte-id als GETAL terug. Een vergelijking zonder normalisatie zou
   * een correct bord afkeuren — dezelfde vorm-mismatch die elders in dit project "niets
   * geselecteerd" opleverde.
   */
  it('accepteert een numeriek werkruimte-id', async () => {
    const read = readerFor({
      id: '1',
      name: 'Labels',
      workspace_id: 5308763,
      description: DESCRIPTION,
    });
    await expect(assertBoardIdentity(read, '1', EXPECTED)).resolves.toBeUndefined();
  });

  it('accepteert spaties om de bordnaam', async () => {
    const read = readerFor({
      id: '1',
      name: ' Labels ',
      workspace_id: '5308763',
      description: DESCRIPTION,
    });
    await expect(assertBoardIdentity(read, '1', EXPECTED)).resolves.toBeUndefined();
  });

  it('weigert een bord met een andere naam, en noemt beide', async () => {
    const read = readerFor({
      id: '1',
      name: 'Briefings',
      workspace_id: '5308763',
      description: DESCRIPTION,
    });
    await expect(assertBoardIdentity(read, '1', EXPECTED)).rejects.toThrow(/Briefings.*Labels/s);
  });

  /** Twee werkruimtes kunnen allebei een bord "Labels" hebben; de naam alleen is niet genoeg. */
  it('weigert het juiste bord in de verkeerde werkruimte', async () => {
    const read = readerFor({
      id: '1',
      name: 'Labels',
      workspace_id: '999',
      description: DESCRIPTION,
    });
    await expect(assertBoardIdentity(read, '1', EXPECTED)).rejects.toThrow('999');
  });

  it('weigert een bord dat niet bestaat', async () => {
    await expect(assertBoardIdentity(readerFor(null), '1', EXPECTED)).rejects.toThrow(
      'bestaat niet'
    );
  });
});

/**
 * De regressie die `assertBoardIdentity` bestaat om te voorkomen, hier van de andere kant
 * bekeken: zónder die controle verwijdert het herstelpad de eerste 50 items van wat voor bord
 * dan ook waarvan iemand het id in het intentiebestand zet.
 */
describe('cleanupSamples zonder vastgelegde voorbeeldinhoud', () => {
  const readerWith = (items: Array<{ id: string; name: string }>, groepTitel: string) => ({
    query: async () => ({
      boards: [
        {
          columns: [{ id: 'iets_anders' }],
          groups: [{ id: 'g1', title: groepTitel }],
          items_page: { items },
        },
      ],
    }),
  });

  const intentUncaptured = (): ProvisionIntent => ({
    runId: 'r',
    startedAt: Date.now(),
    boardId: 'verkeerd',
    samples: { phase: 'uncaptured' },
  });

  /** Expliciet getypeerd; `ReturnType<typeof vi.fn>` is te breed voor de `Writer`-vorm. */
  type Mutate = (
    query: string,
    variables?: Record<string, unknown>,
    options?: { idempotencyKey?: string }
  ) => Promise<unknown>;

  const run = (read: ReturnType<typeof readerWith>, mutate: Mutate) =>
    cleanupSamples(
      read,
      { mutate },
      'verkeerd',
      intentUncaptured(),
      { read: () => null, write: () => undefined },
      { ourColumnIds: ['itg_kleur'], groupTitle: 'Labels', log: () => undefined }
    );

  /**
   * Deze tak is UITSLUITEND het herstelpad: bij een normale run legt `captureSamples` de ids
   * direct na `create_board` vast, dus dan is het plan `delete`. Hier is dus per definitie
   * niet bekend wat van Monday is en wat van ITG — en dan wordt er niets verwijderd.
   */
  it('WEIGERT te verwijderen, ook als het bord er vers uitziet', async () => {
    const mutate = vi.fn(async (_q: string) => ({}));
    await expect(
      run(readerWith([{ id: 'sample-1', name: 'Item 1' }], 'Group Title'), mutate)
    ).rejects.toThrow('niet vastgelegd wat daar van Monday is');
    expect(mutate).not.toHaveBeenCalled();
  });

  /** En al helemaal op een bord dat zichtbaar in gebruik is. */
  it('weigert ook op een bord met echte rijen', async () => {
    const mutate = vi.fn(async (_q: string) => ({}));
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `echt-${i}`, name: 'Echte rij' }));
    await expect(run(readerWith(items, 'Gegenereerde briefings'), mutate)).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
  });

  /** De melding noemt de inhoud, zodat een mens kan wegen wat hij ziet. */
  it('noemt de inhoud van het bord in de melding', async () => {
    const message = await run(
      readerWith([{ id: 'x', name: 'y' }], 'Group Title'),
      vi.fn(async (_q: string) => ({}))
    ).catch((e: Error) => e.message);
    expect(message).toContain('1 item(s)');
    expect(message).toContain('"Group Title"');
    expect(message).toContain('"phase":"captured"');
  });

  /**
   * Alleen `boardId` weghalen laat `startedAt` staan. Is het idempotentievenster verlopen —
   * en dat is bij een herstel meestal zo — dan weigert `unresolvedCreateVerdict` de volgende
   * run een nieuw bord aan te maken, en zit de operator klem. De melding moet dus het HELE
   * bestand noemen, niet alleen het veld.
   */
  it('wijst op het hele intentiebestand, niet alleen op boardId', async () => {
    const message = await run(
      readerWith([{ id: 'x', name: 'y' }], 'Group Title'),
      vi.fn(async (_q: string) => ({}))
    ).catch((e: Error) => e.message);
    expect(message).toContain('HELE');
    expect(message).toContain('startedAt');
    expect(message).not.toMatch(/verwijder "boardId"/);
  });
});

describe('describeBoardShape', () => {
  const board = (items: number, ...groepen: string[]) => ({
    columns: [],
    groups: groepen.map((title, i) => ({ id: `g${i}`, title })),
    items: Array.from({ length: items }, (_, i) => ({ id: `i${i}`, name: `Item ${i}` })),
  });

  /**
   * Beschrijft alleen; beslist niets. Een eerdere versie leidde uit deze vorm af of er
   * verwijderd mocht worden, en dat is geen eigendomsbewijs.
   */
  it('noemt het aantal items en de groepen', () => {
    expect(describeBoardShape(board(2, 'Group Title'))).toBe('2 item(s), groepen: "Group Title"');
  });

  it('zegt het als er geen groepen zijn', () => {
    expect(describeBoardShape(board(0))).toBe('0 item(s), groepen: geen');
  });
});

describe('intentFile leest een OUD bestand', () => {
  const write = (data: unknown): string => {
    const p = join(tmpdir(), `intent-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(data));
    return p;
  };

  /**
   * Het eerste formaat had alleen `runId` en `boardId`. Zonder aanvulling blijft `samples`
   * `undefined` en struikelt `sampleCleanupPlan` over `samples.phase` — een crash bij precies
   * de herstelrun waar dit bestand voor bestaat.
   */
  it('vult een ontbrekende samples aan tot uncaptured', () => {
    const intent = intentFile(write({ runId: 'r1', boardId: '123' })).read();
    expect(intent?.samples).toEqual({ phase: 'uncaptured' });
  });

  /** `startedAt: 0` is ouder dan elk venster, dus een onbesliste create wordt geweigerd. */
  it('valt terug op startedAt 0', () => {
    expect(intentFile(write({ runId: 'r1' })).read()?.startedAt).toBe(0);
  });

  it('behoudt een vastgelegde samples', () => {
    const p = write({ runId: 'r1', samples: { phase: 'captured', itemIds: [1], groupIds: ['g'] } });
    expect(intentFile(p).read()?.samples).toEqual({
      phase: 'captured',
      itemIds: ['1'],
      groupIds: ['g'],
    });
  });

  it('werpt op een bestand zonder runId in plaats van stil door te gaan', () => {
    expect(() => intentFile(write({ boardId: '123' })).read()).toThrow('runId');
  });
});
