'use client';

import type { MondayBridge } from '@components/recommendations/monday-client';
import type { SavedChecklist } from '@lib/briefing/answers';
import type { BriefingTraining } from '@lib/briefing/types';

/**
 * Aanroepen naar onze eigen backend, met het sessietoken van Monday.
 *
 * Zelfde opzet als `components/recommendations/api.ts`, en met opzet dezelfde brug: het is
 * dezelfde Monday-app, dus een vers token per aanroep en één herkansing bij een 401. Een
 * token dat is opgehaald toen de tab openging verloopt terwijl hij open blijft staan — een
 * adviseur die tussendoor gaat lunchen komt anders terug bij een scherm dat stilletjes niets
 * meer opslaat.
 *
 * De typen komen als `import type` uit `lib/`, zodat er geen tweede kopie van de vorm
 * ontstaat die stilletjes uiteen kan lopen. Type-imports verdwijnen bij het compileren, dus
 * er komt niets server-only in de bundel.
 */

/**
 * Wat de tab van de backend krijgt.
 *
 * De **training en de opgeslagen antwoorden**, niet het uitgerekende scherm: dat rekent de tab
 * zelf uit met `buildTabView`, zodat het meebeweegt met elk vinkje in plaats van bevroren te
 * blijven op de stand bij het laden.
 */
export interface BriefingPayload {
  readonly training: BriefingTraining;
  readonly saved: SavedChecklist | null;
  /** Ondoorzichtig token voor het opslaan. Echo het terug; interpreteer het nooit. */
  readonly token: string;
  /** Er stáát iets opgeslagen dat niet te lezen is — iets anders dan dat er niets staat. */
  readonly unreadable: boolean;
}

export interface SaveResult {
  readonly saved: SavedChecklist | null;
  readonly token: string;
}

/** Een botsing: iemand anders heeft intussen opgeslagen. Draagt de huidige stand mee. */
export class BriefingConflict extends Error {
  constructor(
    readonly saved: SavedChecklist | null,
    readonly token: string
  ) {
    super('iemand anders heeft deze checklist intussen opgeslagen');
    this.name = 'BriefingConflict';
  }
}

/** Een fout mét de HTTP-status, zodat de aanroeper 403 van 500 kan onderscheiden. */
export class BriefingApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'BriefingApiError';
  }
}

export interface BriefingApi {
  get(itemId: string, signal?: AbortSignal): Promise<BriefingPayload>;
  saveChecklist(
    itemId: string,
    input: SavedChecklist & { token: string },
    options?: { keepalive?: boolean }
  ): Promise<SaveResult>;
}

const UNAUTHORIZED = 401;
const CONFLICT = 409;

interface Envelope {
  success: boolean;
  data?: unknown;
  error?: string;
}

export function createBriefingApi(monday: MondayBridge): BriefingApi {
  async function send(
    path: string,
    init: RequestInit,
    signal?: AbortSignal
  ): Promise<Envelope> {
    const attempt = async (): Promise<Response> => {
      const token = await monday.sessionToken();
      return await fetch(path, {
        ...init,
        signal,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    };

    let response = await attempt();
    if (response.status === UNAUTHORIZED) {
      // Eén herkansing met een vers token. Lukt het dan nog niet, dan is het antwoord echt
      // "dit mag je niet", en verder proberen maakt een duidelijke weigering tot een hang.
      response = await attempt();
    }

    const body: Envelope = await response.json().catch(() => ({
      success: false,
      error: 'de server stuurde iets dat geen JSON was',
    }));

    if (response.status === CONFLICT) {
      const data = asSaveResult(body.data);
      throw new BriefingConflict(data.saved, data.token);
    }
    if (!response.ok || !body.success) {
      throw new BriefingApiError(response.status, body.error ?? `verzoek mislukt (${response.status})`);
    }
    return body;
  }

  const base = (itemId: string): string => `/api/briefing/${encodeURIComponent(itemId)}`;

  return {
    async get(itemId, signal) {
      const body = await send(base(itemId), { method: 'GET' }, signal);
      return asPayload(body.data);
    },

    async saveChecklist(itemId, input, options) {
      const body = await send(`${base(itemId)}/checklist`, {
        method: 'PUT',
        body: JSON.stringify(input),
        // `keepalive` laat het verzoek het document overleven, voor de laatste redding als
        // Monday de iframe verbergt of vervangt. Best-effort, nooit een garantie.
        keepalive: options?.keepalive,
      });
      return asSaveResult(body.data);
    },
  };
}

/**
 * De backend beslist wat er in staat; hier controleren we alleen dat het de vorm heeft die
 * het scherm aankan. Zonder deze controle valt een veranderd antwoord om als
 * `undefined is not an object`, halverwege het renderen, zonder te zeggen wat er miste.
 */
function asPayload(data: unknown): BriefingPayload {
  if (data === null || typeof data !== 'object') {
    throw new BriefingApiError(500, 'de server stuurde geen briefinggegevens');
  }
  const payload = data as Partial<BriefingPayload>;
  if (payload.training === undefined || typeof payload.token !== 'string') {
    throw new BriefingApiError(500, 'de briefinggegevens misten een verplicht veld');
  }
  return {
    training: payload.training,
    saved: payload.saved ?? null,
    token: payload.token,
    unreadable: payload.unreadable === true,
  };
}

function asSaveResult(data: unknown): SaveResult {
  if (data === null || typeof data !== 'object') {
    throw new BriefingApiError(500, 'de server stuurde geen opslagresultaat');
  }
  const result = data as Partial<SaveResult>;
  if (typeof result.token !== 'string') {
    throw new BriefingApiError(500, 'het opslagresultaat miste het token');
  }
  return { saved: result.saved ?? null, token: result.token };
}
