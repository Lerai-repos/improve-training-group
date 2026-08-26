/**
 * De Microsoft Graph-client, app-only.
 *
 * Client credentials en geen gebruikersaanmelding: de briefing wordt gemaakt door een knop
 * in Monday, niet door een ingelogde bezoeker van deze app. Dat scheelt bovendien de
 * valkuil die de Google-kant wél heeft — daar verlopen refresh tokens na zeven dagen als de
 * consent-app niet Internal is. Hier is de enige klok die van het secret zelf.
 */

const LOGIN_HOST = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Marge op de vervaltijd, zodat een token niet ómslaat tijdens een trage upload. */
const EXPIRY_MARGIN_MS = 60_000;

export interface GraphConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Een Graph-fout met zijn status erbij, want de status is het halve antwoord.
 *
 * **Let op bij 401 vanaf een SharePoint-pad.** Dat is níet automatisch een verlopen of fout
 * secret. Gemeten op deze tenant: zonder goedgekeurde app-rollen geeft het token-eindpunt
 * gewoon `200` — het token is geldig, er staan alleen geen `roles` in — en antwoordt
 * SharePoint daarna met `401` en een body vol `generalException` / `spException`. Dat leest
 * als kapotte inloggegevens terwijl de beheerder simpelweg nog niet heeft goedgekeurd.
 *
 * Het verschil zie je aan `pad`: faalt het op `token`, dan klopt het secret of de tenant
 * niet. Faalt het op een `/sites/…`-pad, dan is het vrijwel altijd de toestemming.
 * `scripts/_scratch-token.ts`-achtig de claims uitlezen geeft uitsluitsel: geen `roles` =
 * geen consent.
 */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    pad: string
  ) {
    super(`Graph ${status} op ${pad}: ${detail}`);
    this.name = 'GraphError';
  }
}

export interface GraphClient {
  /** Een JSON-verzoek op een pad relatief aan `/v1.0`. */
  json<T>(pad: string, init?: RequestInit): Promise<T>;
  /** Een verzoek dat rauwe bytes stuurt — de upload. */
  put(pad: string, body: Uint8Array, contentType: string): Promise<unknown>;
}

export interface GraphClientOptions {
  fetch?: typeof fetch;
  nowMs?: () => number;
  /**
   * Breekt lopende verzoeken af, bijvoorbeeld bij een naderende functietimeout.
   *
   * Zonder dit kapt het platform de functie zelf af, en dán is er geen `catch` meer: wat er
   * al geüpload is blijft achter zonder dat iemand het vastlegt. Een afbreking die wij zelf
   * veroorzaken is een gewone fout, en daar kan het deelresultaat nog uit.
   */
  signal?: AbortSignal;
}

export function graphConfigFromEnv(): GraphConfig {
  const lees = (naam: string): string => {
    const waarde = process.env[naam];
    if (waarde === undefined || waarde === '') {
      throw new Error(`Missing env ${naam}`);
    }
    return waarde;
  };
  return {
    tenantId: lees('MS_GRAPH_TENANT_ID'),
    clientId: lees('MS_GRAPH_CLIENT_ID'),
    clientSecret: lees('MS_GRAPH_CLIENT_SECRET'),
  };
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

export function createGraphClient(config: GraphConfig, opts: GraphClientOptions = {}): GraphClient {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.nowMs ?? Date.now;

  /**
   * Eén token per instantie, hergebruikt tot vlak voor het verloopt.
   *
   * Een token is een uur geldig en elke aanvraag is een netwerkronde. Zonder dit zou één
   * briefing er vijf ophalen — voor het uitlezen van elk mappenniveau opnieuw.
   */
  let token: { waarde: string; verlooptMs: number } | null = null;

  const haalToken = async (): Promise<string> => {
    if (token !== null && now() < token.verlooptMs) {
      return token.waarde;
    }
    const res = await doFetch(`${LOGIN_HOST}/${config.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      // Ook het token: een herstelvraag die blijft hangen op het ophalen van een token is
      // net zo dodelijk als eentje die blijft hangen op Graph zelf.
      signal: opts.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        // `.default` = precies de app-rollen die de beheerder heeft goedgekeurd, niet meer.
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    });
    const tekst = await res.text();
    if (!res.ok) {
      throw new GraphError(res.status, tekst.slice(0, 400), 'token');
    }
    const data: TokenResponse = JSON.parse(tekst);
    token = {
      waarde: data.access_token,
      verlooptMs: now() + data.expires_in * 1000 - EXPIRY_MARGIN_MS,
    };
    return token.waarde;
  };

  const verstuur = async (pad: string, init: RequestInit): Promise<unknown> => {
    const bearer = await haalToken();
    const res = await doFetch(`${GRAPH}${pad}`, {
      ...init,
      signal: opts.signal,
      headers: { ...init.headers, Authorization: `Bearer ${bearer}` },
    });
    const tekst = await res.text();
    if (!res.ok) {
      throw new GraphError(res.status, tekst.slice(0, 400), pad);
    }
    return tekst === '' ? null : JSON.parse(tekst);
  };

  return {
    async json<T>(pad: string, init: RequestInit = {}): Promise<T> {
      const data = await verstuur(pad, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init.headers },
      });
      return data as T;
    },
    put(pad, body, contentType) {
      /**
       * Een eigen kopie, en dat is een typekwestie én een veiligheidsnetje.
       *
       * `BodyInit` accepteert geen `Uint8Array<ArrayBufferLike>`, want die kan ook over een
       * `SharedArrayBuffer` liggen. Een verse array is altijd gewoon een `ArrayBuffer`. Dat
       * hij losstaat van de invoer is meegenomen: de bytes kunnen niet meer onder een
       * lopende upload vandaan veranderen.
       */
      const bytes = new Uint8Array(body.byteLength);
      bytes.set(body);
      return verstuur(pad, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: bytes.buffer,
      });
    },
  };
}
