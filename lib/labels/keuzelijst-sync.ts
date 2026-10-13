import { OPPORTUNITY_BOARD, OPPORTUNITY_COLUMNS } from '@lib/briefing/columns';
import {
  AGENDA_2025_HISTORY,
  agendaBoardOverride,
  agendaBoardsToConnect,
  discoverAgendaBoards,
  liveAgendaBoards,
} from '@lib/evaluations';
import { AGENDA_2026_COLUMNS, MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

import { labelsBoardId } from './board';
import { controleerNa, leesStatusOpties, planKeuzelijst } from './keuzelijst';
import { readLabelRows } from './read';

import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { MondayMutationClient } from '@lib/monday/mutate';
import type { StatusLabelInvoer, StatusOptie } from './keuzelijst';

/**
 * De labels van het Labels-bord in de keuzelijsten zetten. Zie `keuzelijst.ts` voor het waarom.
 *
 * Drie aanroepers: de webhook op het Labels-bord (een rij erbij of hernoemd), de nachtelijke
 * ronde, en `pnpm labels:keuzelijsten` met de hand. Schrijft alleen als er een label ontbreekt,
 * dus opnieuw draaien is onschuldig.
 */

/** De labelkolom op de agenda; elke kopie van het bord houdt dit id. */
const AGENDA_LABEL = AGENDA_2026_COLUMNS.label;

/** Eén statuskolom die de labels hoort te kennen. */
export interface KeuzelijstDoel {
  readonly boardId: string;
  readonly kolomId: string;
  /** Voor de melding: "Opportunities" of de naam van het agendabord. */
  readonly naam: string;
}

export interface KeuzelijstKolom {
  readonly revision: string;
  readonly opties: readonly StatusOptie[];
}

export interface KeuzelijstDeps {
  readonly dryRun: boolean;
  /** De labelnamen die in elke keuzelijst horen. */
  gewenst(): Promise<readonly string[]>;
  doelen(): Promise<readonly KeuzelijstDoel[]>;
  leesKolom(doel: KeuzelijstDoel): Promise<KeuzelijstKolom>;
  schrijf(
    doel: KeuzelijstDoel,
    revision: string,
    labels: readonly StatusLabelInvoer[]
  ): Promise<void>;
}

export type KeuzelijstUitkomst =
  | { readonly kind: 'compleet' }
  | { readonly kind: 'toegevoegd' | 'zou-toevoegen'; readonly namen: readonly string[] }
  | { readonly kind: 'vol'; readonly namen: readonly string[] }
  | { readonly kind: 'mislukt'; readonly fout: string };

export interface KeuzelijstRapport {
  readonly gewenst: readonly string[];
  readonly doelen: ReadonlyArray<{
    readonly doel: KeuzelijstDoel;
    readonly uitkomst: KeuzelijstUitkomst;
  }>;
}

/** Of de run een fout bevat die een nieuwe poging verdient (de webhook geeft dan een 500). */
export function heeftFouten(rapport: KeuzelijstRapport): boolean {
  return rapport.doelen.some((d) => d.uitkomst.kind === 'mislukt' || d.uitkomst.kind === 'vol');
}

async function eenDoel(
  deps: KeuzelijstDeps,
  doel: KeuzelijstDoel,
  gewenst: readonly string[]
): Promise<KeuzelijstUitkomst> {
  const waar = `${doel.naam} (${doel.boardId}/${doel.kolomId})`;
  const voor = await deps.leesKolom(doel);
  const plan = planKeuzelijst(voor.opties, gewenst, waar);
  if (plan.kind === 'compleet' || plan.kind === 'vol') {
    return plan;
  }
  if (deps.dryRun) {
    return { kind: 'zou-toevoegen', namen: plan.namen };
  }
  await deps.schrijf(doel, voor.revision, plan.labels);

  const na = await deps.leesKolom(doel);
  const problemen = controleerNa(voor.opties, na.opties, plan.namen);
  if (problemen.length > 0) {
    throw new Error(
      `${waar}: na het toevoegen van ${plan.namen.join(', ')} klopt de keuzelijst niet meer: ` +
        `${problemen.join('; ')}. Controleer de kolom in Monday.`
    );
  }
  return { kind: 'toegevoegd', namen: plan.namen };
}

/** Elk doel apart: een fout op het ene bord laat het andere niet zonder het nieuwe label. */
export async function syncKeuzelijsten(deps: KeuzelijstDeps): Promise<KeuzelijstRapport> {
  const [gewenst, doelen] = await Promise.all([deps.gewenst(), deps.doelen()]);
  const uit: Array<{ doel: KeuzelijstDoel; uitkomst: KeuzelijstUitkomst }> = [];
  for (const doel of doelen) {
    try {
      uit.push({ doel, uitkomst: await eenDoel(deps, doel, gewenst) });
    } catch (error) {
      uit.push({
        doel,
        uitkomst: { kind: 'mislukt', fout: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return { gewenst, doelen: uit };
}

// ---------------------------------------------------------------------------------------------
// De echte aansluitingen.

/**
 * De labels die in de keuzelijst horen: elke rij met een naam én een volledige naam.
 *
 * Niet elke rij zodra hij bestaat: wie een rij aanmaakt typt eerst een naam en vult daarna de
 * rest. Pas met een volledige naam is het een label en geen halve tikbeurt, en de webhook vuurt
 * bij elke kolomwijziging, dus het label volgt alsnog meteen.
 */
export async function leesGewensteLabels(client: MondayGraphQLClient): Promise<readonly string[]> {
  const { records } = await readLabelRows(client, labelsBoardId());
  return records.filter((r) => r.volledigeNaam.trim() !== '').map((r) => r.code);
}

/**
 * Agendaborden die geen nieuwe labels krijgen, ook al staan ze in Monday op actief.
 *
 * Agenda 2025 is het jaar van vorig jaar: er komen geen trainingen meer bij, dus een nieuw label
 * heeft er niets te zoeken. Gemeten 13-Oct-2026: hij mist ook `CC` en `CP`, en die er alsnog
 * bijzetten zou een oud bord veranderen zonder dat iemand erom vroeg. Een nieuwe jaargang (de kopie
 * voor 2027) doet wél vanzelf mee.
 */
const GEEN_NIEUWE_LABELS: ReadonlySet<string> = new Set([AGENDA_2025_HISTORY.boardId]);

/** De Opportunity en elk actief agendabord met een labelkolom. */
export async function leesDoelen(client: MondayGraphQLClient): Promise<readonly KeuzelijstDoel[]> {
  const agenda = liveAgendaBoards(
    agendaBoardsToConnect(await discoverAgendaBoards(client), agendaBoardOverride())
  ).filter((b) => b.columnTypes[AGENDA_LABEL] === 'status' && !GEEN_NIEUWE_LABELS.has(b.boardId));
  return [
    { boardId: OPPORTUNITY_BOARD, kolomId: OPPORTUNITY_COLUMNS.label, naam: 'Opportunities' },
    ...agenda.map((b) => ({ boardId: b.boardId, kolomId: AGENDA_LABEL, naam: b.naam })),
  ];
}

interface KolomAntwoord {
  readonly boards?: ReadonlyArray<{
    readonly columns?: ReadonlyArray<{
      readonly id: string;
      readonly type: string;
      readonly revision?: string | null;
      readonly settings?: unknown;
    }> | null;
  }> | null;
}

export async function leesKeuzelijst(
  client: Pick<MondayGraphQLClient, 'query'>,
  doel: KeuzelijstDoel
): Promise<KeuzelijstKolom> {
  const data = await client.query<KolomAntwoord>(
    'query ($b: [ID!], $c: [String!]) { boards(ids: $b) { columns(ids: $c) { id type revision settings } } }',
    { b: [doel.boardId], c: [doel.kolomId] }
  );
  const kolom = data.boards?.[0]?.columns?.[0];
  if (kolom === undefined) {
    throw new Error(`${doel.naam}: kolom ${doel.kolomId} niet gevonden op bord ${doel.boardId}.`);
  }
  if (kolom.type !== 'status') {
    throw new Error(`${doel.naam}: kolom ${doel.kolomId} is geen statuskolom maar ${kolom.type}.`);
  }
  if (typeof kolom.revision !== 'string' || kolom.revision === '') {
    throw new Error(`${doel.naam}: Monday gaf geen revisie voor ${doel.kolomId}.`);
  }
  return { revision: kolom.revision, opties: leesStatusOpties(kolom.settings, doel.naam) };
}

const ZET_LABELS = `mutation ($b: ID!, $c: String!, $r: String!, $labels: [UpdateStatusLabelInput!]!) {
  update_status_column(board_id: $b, id: $c, revision: $r, settings: { labels: $labels }) { id }
}`;

/**
 * De hele lijst terugschrijven, met de revisie van het lezen: heeft iemand de kolom intussen
 * aangepast, dan weigert Monday, en de volgende ronde begint opnieuw met de nieuwe stand.
 */
export async function schrijfKeuzelijst(
  client: MondayMutationClient,
  doel: KeuzelijstDoel,
  revision: string,
  labels: readonly StatusLabelInvoer[]
): Promise<void> {
  await client.mutate(ZET_LABELS, { b: doel.boardId, c: doel.kolomId, r: revision, labels });
}

export function buildKeuzelijstDeps(options: {
  dryRun: boolean;
  deadlineMs?: () => number | null;
  /** Alleen deze doelen in plaats van de echte; voor `pnpm labels:keuzelijsten --proef`. */
  doelen?: readonly KeuzelijstDoel[];
}): KeuzelijstDeps {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN is not configured');
  }
  const read = createMondayGraphQLClient({
    token,
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: options.deadlineMs,
  });
  const write = createMondayMutationClient({
    token,
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: options.deadlineMs,
  });
  const vast = options.doelen;
  return {
    dryRun: options.dryRun,
    gewenst: () => leesGewensteLabels(read),
    doelen: () => (vast === undefined ? leesDoelen(read) : Promise.resolve(vast)),
    leesKolom: (doel) => leesKeuzelijst(read, doel),
    schrijf: (doel, revision, labels) => schrijfKeuzelijst(write, doel, revision, labels),
  };
}
