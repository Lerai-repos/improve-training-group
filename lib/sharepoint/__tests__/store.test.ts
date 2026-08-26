import { describe, expect, it } from 'vitest';

import { createGraphClient, GraphError, type GraphClient } from '../graph';
import { createSharePointStore, resolveSiteId } from '../store';

/**
 * Het enige stuk dat SharePoint echt aanraakt.
 *
 * Getest tegen een nagebootste Graph, want wat hier fout kan gaan zijn de randgevallen van
 * het protocol — een map die niet bestaat, twee generaties tegelijk — en niet de inhoud van
 * het antwoord.
 */

const SITE = 'contoso.sharepoint.com,1111,2222';

interface Aanroep {
  readonly pad: string;
  readonly method: string;
  readonly body?: string;
}

function graph(
  antwoord: (pad: string, method: string) => unknown
): GraphClient & { aanroepen: readonly Aanroep[] } {
  const aanroepen: Aanroep[] = [];
  return {
    aanroepen,
    json<T>(pad: string, init: RequestInit = {}): Promise<T> {
      const method = init.method ?? 'GET';
      aanroepen.push({ pad, method, body: typeof init.body === 'string' ? init.body : undefined });
      const uit = antwoord(pad, method);
      return uit instanceof Error ? Promise.reject(uit) : Promise.resolve(uit as T);
    },
    put(pad: string): Promise<unknown> {
      aanroepen.push({ pad, method: 'PUT' });
      const uit = antwoord(pad, 'PUT');
      return uit instanceof Error ? Promise.reject(uit) : Promise.resolve(uit);
    },
  };
}

const mappen = (...namen: string[]): { value: unknown[] } => ({
  value: namen.map((name) => ({ name, folder: { childCount: 0 } })),
});

describe('children', () => {
  it('geeft alleen mappen terug, geen bestanden', async () => {
    const client = graph(() => ({
      value: [{ name: '1. JE', folder: { childCount: 3 } }, { name: 'Briefing X.docx' }],
    }));

    const uit = await createSharePointStore(client, SITE).children('General');

    expect(uit).toEqual(['1. JE']);
  });

  /**
   * Een pad dat niet bestaat is een antwoord, geen fout.
   *
   * `resolve.ts` vraagt met opzet naar de jaarmap, die er onder JE níet is. Zou dat de hele
   * generatie omgooien, dan werkt de functie alleen op labels die toevallig al opgeruimd
   * zijn.
   */
  it('leest een ontbrekende map als leeg', async () => {
    const client = graph(() => new GraphError(404, 'itemNotFound', '/x'));

    const uit = await createSharePointStore(client, SITE).children('General/1. JE/5. Klanten/2026');

    expect(uit).toEqual([]);
  });

  /** Een 403 betekent iets heel anders dan een lege map en mag nooit als leeg landen. */
  it('laat een toestemmingsfout wél door', async () => {
    const client = graph(() => new GraphError(403, 'accessDenied', '/x'));

    await expect(createSharePointStore(client, SITE).children('General')).rejects.toThrow(/403/);
  });

  /** Spaties en punten in mapnamen moeten gecodeerd, de padscheiding niet. */
  it('codeert de mapnamen zonder het pad te breken', async () => {
    const client = graph(() => mappen());

    await createSharePointStore(client, SITE).children('General/1. JE/5. Klanten');

    expect(client.aanroepen[0].pad).toContain('/root:/General/1.%20JE/5.%20Klanten:/children');
  });

  it('vraagt de wortel op zonder dubbele punt', async () => {
    const client = graph(() => mappen());

    await createSharePointStore(client, SITE).children('');

    expect(client.aanroepen[0].pad).toContain('/drive/root/children');
  });
});

describe('createFolder', () => {
  it('maakt de map met de opgegeven naam', async () => {
    const client = graph(() => ({ id: '1' }));

    await createSharePointStore(client, SITE).createFolder(
      'General/1. JE/5. Klanten',
      'Nieuwe Klant BV'
    );

    const [aanroep] = client.aanroepen;
    expect(aanroep.method).toBe('POST');
    expect(JSON.parse(aanroep.body ?? '{}')).toMatchObject({
      name: 'Nieuwe Klant BV',
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    });
  });

  /**
   * Twee briefings voor dezelfde nieuwe klant tegelijk. De tweede botst, en dat is precies
   * de uitkomst die we wilden: de map bestaat. Met `rename` zou er `Klant 1` naast `Klant`
   * ontstaan en stond de historie van één klant voorgoed op twee plekken.
   */
  it('vindt een botsing goed nieuws, geen fout', async () => {
    const client = graph(() => new GraphError(409, 'nameAlreadyExists', '/x'));

    await expect(
      createSharePointStore(client, SITE).createFolder('General', 'Klant')
    ).resolves.toBeUndefined();
  });

  it('laat andere fouten wel door', async () => {
    const client = graph(() => new GraphError(403, 'accessDenied', '/x'));

    await expect(
      createSharePointStore(client, SITE).createFolder('General', 'Klant')
    ).rejects.toThrow(/403/);
  });
});

describe('upload', () => {
  it('zet het bestand op het volledige pad en geeft de link terug', async () => {
    const client = graph(() => ({
      id: '01ABC',
      name: 'Briefing Calduran - JE - 09-10-2026 - Frank.docx',
      webUrl: 'https://contoso.sharepoint.com/sites/x/Briefing.docx',
    }));

    const uit = await createSharePointStore(client, SITE).upload(
      'General/1. JE/5. Klanten/Calduran',
      'Briefing Calduran - JE - 09-10-2026 - Frank.docx',
      new Uint8Array([1, 2, 3])
    );

    expect(client.aanroepen[0].pad).toContain('/Calduran/Briefing%20Calduran');
    expect(client.aanroepen[0].pad).toContain(':/content');
    expect(uit.webUrl).toContain('Briefing.docx');
    expect(uit.id).toBe('01ABC');
  });

  /** Zonder link is de upload waardeloos: Monday en het Briefings-bord krijgen niets. */
  it('weigert een antwoord zonder bruikbare link', async () => {
    const client = graph(() => ({ id: '01ABC' }));

    await expect(
      createSharePointStore(client, SITE).upload('General', 'X.docx', new Uint8Array([1]))
    ).rejects.toThrow(/geen bruikbaar antwoord/);
  });
});

describe('afbreken', () => {
  /**
   * Zonder eigen afbreking kapt het platform de functie af, en dán is er geen `catch` meer:
   * wat er al geüpload is blijft achter zonder dat iemand het vastlegt. Een afbreking die
   * wij zelf veroorzaken is een gewone fout, en daar komt het deelresultaat nog uit.
   */
  it('geeft het signaal door aan elk verzoek', async () => {
    const gezien: (AbortSignal | null | undefined)[] = [];
    const controller = new AbortController();
    const client = createGraphClient(
      { tenantId: 't', clientId: 'c', clientSecret: 's' },
      {
        signal: controller.signal,
        fetch: ((url: string, init: RequestInit = {}) => {
          if (String(url).includes('/oauth2/')) {
            return Promise.resolve(
              new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), { status: 200 })
            );
          }
          gezien.push(init.signal);
          return Promise.resolve(new Response('{"value":[]}', { status: 200 }));
        }) as unknown as typeof fetch,
      }
    );

    await createSharePointStore(client, SITE).children('General');

    expect(gezien).toEqual([controller.signal]);
  });
});

describe('resolveSiteId', () => {
  it('vraagt de site op via host en pad', async () => {
    const client = graph(() => ({ id: SITE }));

    const uit = await resolveSiteId(client, {
      host: 'improvetraininggroup.sharepoint.com',
      path: '/sites/ImproveTrainingGroup',
    });

    expect(uit).toBe(SITE);
    expect(client.aanroepen[0].pad).toBe(
      '/sites/improvetraininggroup.sharepoint.com:/sites/ImproveTrainingGroup'
    );
  });
});
