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

/**
 * Het plan is verschoven tussen tonen en bevestigen, en draagt het nieuwe plan mee.
 *
 * Geen gewone fout: er is niets stuk en er hoeft niets opnieuw geprobeerd te worden. De
 * adviseur moet alleen kijken naar wat er nú ligt — een collega heeft een bestand
 * neergezet, of de checklist is gewijzigd — en opnieuw beslissen.
 */
export class BriefingPlanChanged extends Error {
  constructor(
    readonly plan: BriefingPlan,
    message: string
  ) {
    super(message);
    this.name = 'BriefingPlanChanged';
  }
}

/** Een fout mét de HTTP-status, zodat de aanroeper 403 van 500 kan onderscheiden. */
export class BriefingApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Wat de server naast de melding meestuurde; bij een verschoven plan het nieuwe plan. */
    readonly data?: GenerateResponse
  ) {
    super(message);
    this.name = 'BriefingApiError';
  }
}

/**
 * Wat het plannen oplevert: waar het heen gaat en wat er al ligt.
 *
 * Er is nog niets gemaakt of geschreven als dit terugkomt. `conflicts` bepaalt of de
 * adviseur eerst iets moet bevestigen.
 */
export interface BriefingPlan {
  readonly stage: 'planned';
  readonly folderPath: string;
  readonly folderExists: boolean;
  /** Namen die precies zo al bestaan; hierop hangt de bevestiging. */
  readonly conflicts: readonly string[];
  /** Elke briefing van deze training die er al ligt, ook die van vóór een verzette datum. */
  readonly related: readonly string[];
  readonly filenames: readonly string[];
  /**
   * Ondoorzichtige vingerafdruk van dít plan. Stuur hem terug bij het bevestigen; de server
   * weigert als er intussen iets is veranderd. Nooit zelf uitlezen of samenstellen.
   */
  readonly planToken: string;
  /**
   * Waaróm dit plan verschoven is, als het antwoord op een botsing kwam.
   *
   * `files` betekent: er staan andere bestanden in de map. `input` betekent: een collega
   * heeft de checklist gewijzigd — en dan klopt het formulier op het scherm niet meer, want
   * de volgende generatie zou op hún antwoorden gebouwd worden.
   */
  readonly changed?: 'files' | 'input';
}

export interface WrittenDocument {
  readonly trainerNaam: string;
  readonly role: 'lead' | 'co' | 'acteur';
  readonly file: { readonly name: string; readonly webUrl: string };
  readonly versioned: boolean;
  /** Bronnen die als zichtbare regel in dít document landen. */
  readonly open: readonly string[];
}

export interface BriefingWritten {
  readonly stage: 'written';
  /** True als niet elk document is gelukt; wat er staat, staat er wel definitief. */
  readonly partial?: boolean;
  readonly failure?: { readonly filename: string; readonly reason: string };
  readonly documents: readonly WrittenDocument[];
  /** Waarschuwingen die het genereren niet tegenhielden. */
  readonly notes: readonly { readonly kind: string; readonly tekst: string }[];
  /** Wat er niet in Monday is vastgelegd terwijl de documenten er wél staan. */
  readonly administratie: readonly string[];
  readonly brie: string;
}

export type GenerateResponse = BriefingPlan | BriefingWritten;

export interface BriefingApi {
  get(itemId: string, signal?: AbortSignal): Promise<BriefingPayload>;
  saveChecklist(
    itemId: string,
    input: SavedChecklist & { token: string },
    options?: { keepalive?: boolean }
  ): Promise<SaveResult>;
  /**
   * Zonder `confirmExisting` plant het alleen; mét bevestiging schrijft het.
   *
   * Dat vlaggetje is het slot: er is geen aanroep die een bestaande briefing vervangt, en
   * bevestigen levert een `(v2)` naast het origineel in plaats van eroverheen.
   */
  generate(
    itemId: string,
    options?: { confirmExisting?: boolean; planToken?: string }
  ): Promise<GenerateResponse>;
}

const UNAUTHORIZED = 401;
const CONFLICT = 409;

interface Envelope {
  success: boolean;
  data?: unknown;
  error?: string;
}

export function createBriefingApi(monday: MondayBridge): BriefingApi {
  /**
   * `alsBotsing` bepaalt of een 409 als opslagbotsing gelezen wordt.
   *
   * Alleen het opslaan van de checklist gebruikt 409 daarvoor. Genereren gebruikt dezelfde
   * status voor heel andere dingen — onleesbare invoer, een plan dat is verschoven, een
   * geweigerde schrijfactie — en die dragen géén opslagresultaat. Ze allemaal door
   * `asSaveResult` duwen wierp "het opslagresultaat miste het token" en gooide zowel de
   * échte uitleg als het nieuwe plan weg.
   */
  async function send(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    alsBotsing = false
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

    if (response.status === CONFLICT && alsBotsing) {
      const data = asSaveResult(body.data);
      throw new BriefingConflict(data.saved, data.token);
    }
    if (!response.ok || !body.success) {
      throw new BriefingApiError(
        response.status,
        body.error ?? `verzoek mislukt (${response.status})`,
        // Zonder dit is `BriefingPlanChanged` onbereikbaar: de server stuurt het bijgewerkte
        // plan mee juist zodat de adviseur kan zien wát er veranderde.
        veiligGenerateResponse(body.data)
      );
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
      const body = await send(
        `${base(itemId)}/checklist`,
        {
          method: 'PUT',
          body: JSON.stringify(input),
          // `keepalive` laat het verzoek het document overleven, voor de laatste redding als
          // Monday de iframe verbergt of vervangt. Best-effort, nooit een garantie.
          keepalive: options?.keepalive,
        },
        undefined,
        true
      );
      return asSaveResult(body.data);
    },

    async generate(itemId, options) {
      try {
        const body = await send(`${base(itemId)}/generate`, {
          method: 'POST',
          body: JSON.stringify({
            confirmExisting: options?.confirmExisting === true,
            planToken: options?.planToken,
          }),
        });
        return asGenerateResponse(body.data);
      } catch (error) {
        /**
         * Een 409 mét een plan erin is geen mislukking maar nieuw nieuws.
         *
         * De server stuurt het bijgewerkte plan mee juist zodat de adviseur kan zien wát er
         * veranderd is. Dat als kale foutmelding tonen zou hem terugsturen naar Genereren
         * zonder te vertellen waarnaar hij kijkt.
         */
        if (error instanceof BriefingApiError && error.status === CONFLICT) {
          const plan = error.data;
          if (plan !== undefined && plan.stage === 'planned') {
            throw new BriefingPlanChanged(plan, error.message);
          }
        }
        throw error;
      }
    },
  };
}

/** Hetzelfde als `asGenerateResponse`, maar zwijgend: bij twijfel gewoon niets. */
function veiligGenerateResponse(data: unknown): GenerateResponse | undefined {
  try {
    return asGenerateResponse(data);
  } catch {
    return undefined;
  }
}

/** Alleen de vorm controleren; de backend beslist wat erin staat. */
function asGenerateResponse(data: unknown): GenerateResponse {
  if (data === null || typeof data !== 'object' || !('stage' in data)) {
    throw new BriefingApiError(500, 'de server stuurde geen generatieresultaat');
  }
  const stage = data.stage;
  if (stage === 'planned') {
    const plan = data as Partial<BriefingPlan>;
    if (typeof plan.folderPath !== 'string' || typeof plan.planToken !== 'string') {
      throw new BriefingApiError(500, 'het plan miste de doelmap of zijn token');
    }
    return {
      stage: 'planned',
      folderPath: plan.folderPath,
      folderExists: plan.folderExists === true,
      conflicts: plan.conflicts ?? [],
      related: plan.related ?? [],
      filenames: plan.filenames ?? [],
      planToken: plan.planToken,
      changed: plan.changed === 'input' || plan.changed === 'files' ? plan.changed : undefined,
    };
  }
  if (stage === 'written') {
    const written = data as Partial<BriefingWritten>;
    if (!Array.isArray(written.documents)) {
      throw new BriefingApiError(500, 'het resultaat miste de documenten');
    }
    return {
      stage: 'written',
      partial: written.partial === true,
      failure: written.failure,
      documents: written.documents,
      notes: written.notes ?? [],
      administratie: written.administratie ?? [],
      brie: written.brie ?? '',
    };
  }
  throw new BriefingApiError(500, `onbekende uitkomst "${String(stage)}"`);
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
