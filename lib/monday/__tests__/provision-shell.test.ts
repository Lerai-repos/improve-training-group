import { describe, expect, it, vi } from 'vitest';

import {
  assertBoardIdentity,
  cleanupSamples,
  intentFile,
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
describe('cleanupSamples op een bord waar niets van ons staat', () => {
  it('legt de bestaande items vast en verwijdert ze', async () => {
    const items = [
      { id: 'echt-1', name: 'Een echte rij' },
      { id: 'echt-2', name: 'Nog een' },
    ];
    const read = {
      query: async () => ({
        boards: [{ columns: [{ id: 'iets_anders' }], groups: [], items_page: { items } }],
      }),
    };
    const mutate = vi.fn(async () => ({}));
    const intent: ProvisionIntent = {
      runId: 'r',
      startedAt: Date.now(),
      boardId: 'verkeerd',
      samples: { phase: 'uncaptured' },
    };

    await cleanupSamples(
      read,
      { mutate },
      'verkeerd',
      intent,
      { read: () => null, write: () => undefined },
      { ourColumnIds: ['itg_kleur'], groupTitle: 'Labels', log: () => undefined }
    );

    // Dit IS het gevaar, vastgelegd: zonder identiteitscontrole vooraf gaan er echte rijen weg.
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mutate.mock.calls)).toContain('delete_item');
  });
});

describe('intentFile', () => {
  it('geeft null voor een bestand dat niet bestaat', () => {
    expect(intentFile('/tmp/bestaat-echt-niet-abc123.json').read()).toBeNull();
  });
});
