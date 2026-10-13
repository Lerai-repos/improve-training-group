import { createOAuthGoogleAuth } from '@lib/evaluations/google-sheets-source';
import { oauthCredentialsFromEnv } from '@lib/evaluations/sheet-documents';

import { antwoordenVoor } from './antwoorden';

import type { GoogleAuth } from '@lib/evaluations/google-sheets-source';
import type { InventarisatieStand } from './antwoorden';

/**
 * De antwoordensheet van het generieke inventarisatieformulier ("* ITG - Inventarisatie generiek
 * (Antwoorden)"), in de gedeelde map van ITG. Onze Google-koppeling leest hem; gecontroleerd
 * 13-Oct-2026.
 */
export const INVENTARISATIE_SHEET = {
  id: '1w2hKH85ze92tQ1c7infzDK3X9mj35jECSSpjKlpS140',
  tab: 'Formulierreacties',
} as const;

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
/** Eén sheet van een paar honderd rijen; langer wachten houdt alleen de tab op. */
const TIMEOUT_MS = 10_000;

export async function leesInventarisatieRijen(
  auth: GoogleAuth,
  fetchImpl: typeof fetch = fetch
): Promise<readonly (readonly string[])[]> {
  const url =
    `${SHEETS_API}/${INVENTARISATIE_SHEET.id}/values/` +
    `${encodeURIComponent(INVENTARISATIE_SHEET.tab)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`;
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${await auth.accessToken()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Inventarisatiesheet lezen mislukt (${response.status}).`);
  }
  const body: { values?: unknown } = await response.json();
  if (!Array.isArray(body.values)) {
    throw new Error('Inventarisatiesheet gaf geen rijen terug.');
  }
  return body.values.map((rij: unknown) =>
    Array.isArray(rij) ? rij.map((cel: unknown) => (typeof cel === 'string' ? cel : String(cel ?? ''))) : []
  );
}

/** Per Opportunity de stand, uit één keer gelezen rijen. */
export type InventarisatieBron = (opportunityId: string) => InventarisatieStand;

/**
 * De sheet één keer lezen, en daarna per Opportunity opzoeken. Zo kan het lezen beginnen vóórdat
 * bekend is bij welke Opportunity de training hoort, naast het lezen van de training zelf.
 *
 * Vangt elke fout af als `onleesbaar`: een storing bij Google hoort de tab niet plat te leggen,
 * maar mag ook nooit lezen als "niet ingevuld". Ontbrekende Google-sleutels vallen daar ook onder.
 */
export async function leesInventarisatieBron(
  auth?: GoogleAuth,
  fetchImpl: typeof fetch = fetch
): Promise<InventarisatieBron> {
  let rijen: readonly (readonly string[])[];
  try {
    rijen = await leesInventarisatieRijen(
      auth ?? createOAuthGoogleAuth(oauthCredentialsFromEnv()),
      fetchImpl
    );
  } catch (error) {
    const fout = error instanceof Error ? error.message : String(error);
    return () => ({ kind: 'onleesbaar', fout });
  }
  return (opportunityId) => {
    try {
      return antwoordenVoor(rijen, opportunityId);
    } catch (error) {
      return { kind: 'onleesbaar', fout: error instanceof Error ? error.message : String(error) };
    }
  };
}
