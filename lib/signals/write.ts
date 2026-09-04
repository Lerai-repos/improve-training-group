import { createHash } from 'node:crypto';

import { CLOSED_BY_CHECK, SIGNAL_COLUMNS } from './columns';

import type { MondayMutationClient } from '@lib/monday/mutate';
import type { GroupMove } from './move';
import type { ExistingSignal, SignalAction } from './reconcile';
import type { Soort } from './types';

/** De sleutel van de doorlopende samenvattingsrij. Er is er precies één. */
export const SUMMARY_KEY = 'samenvatting';

const CREATE_ITEM = `mutation ($board: ID!, $group: String!, $name: String!, $values: JSON!) {
  create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $values) { id }
}`;

const CHANGE_VALUES = `mutation ($board: ID!, $item: ID!, $values: JSON!) {
  change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values) { id }
}`;

const MOVE_ITEM = `mutation ($item: ID!, $group: String!) {
  move_item_to_group(item_id: $item, group_id: $group) { id }
}`;

/**
 * Een idempotency-sleutel moet ASCII zijn — hij reist als HTTP-header, en een labelwaarde uit
 * Monday mag alles bevatten; een `é` laat `fetch` zelf struikelen.
 *
 * **Daarom een digest en geen tekstvervanging.** Onveilige tekens vervangen door `_` is
 * verliesgevend: `A/B` en `A B` worden allebei `A_B`, en afkappen laat twee lange labels met
 * hetzelfde begin samenvallen. Twee verschillende meldingen zouden dan één sleutel delen, en
 * Monday geeft binnen dertig minuten simpelweg het eerste antwoord terug — de tweede melding
 * verschijnt dan nooit, zonder fout.
 *
 * Het bord- en run-id blijven leesbaar vóór de digest, zodat een sleutel in een log nog te
 * plaatsen is.
 */
function idempotencyKey(boardId: string, runId: string, sleutel: string): string {
  const digest = createHash('sha256').update(sleutel, 'utf8').digest('hex').slice(0, 32);
  return `signal:${boardId}:${runId}:create:${digest}`;
}

/** `{date, time}` in UTC — Monday slaat een datumkolom met tijd altijd in UTC op. */
function tijdstip(now: Date): { date: string; time: string } {
  const iso = now.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

export interface SignalFields {
  readonly naam: string;
  readonly soort: Soort;
  readonly onderdeel: string;
  readonly detail: string;
  readonly sleutel: string;
  /** In welke groep de rij komt te staan — meldingen en de samenvatting horen niet bij elkaar. */
  readonly groupId: string;
}

function columnValues(fields: SignalFields, now: Date): Record<string, unknown> {
  return {
    [SIGNAL_COLUMNS.tijdstip]: tijdstip(now),
    [SIGNAL_COLUMNS.soort]: { label: fields.soort },
    [SIGNAL_COLUMNS.onderdeel]: fields.onderdeel,
    [SIGNAL_COLUMNS.detail]: fields.detail,
    [SIGNAL_COLUMNS.sleutel]: fields.sleutel,
  };
}

/** Nederlandse datum voor in een regel tekst: `4-9-2026`. */
export function dutchDate(now: Date): string {
  return `${now.getUTCDate()}-${now.getUTCMonth() + 1}-${now.getUTCFullYear()}`;
}

/**
 * De regel die boven het Detail komt zodra de controle een melding zelf afvinkt.
 *
 * Bovenaan en niet onderaan: in Monday's itemweergave zie je de eerste regels van een lange
 * tekst zonder hem open te klappen, dus dit is de enige plek waar het opvalt. En met een
 * datum, want "wanneer was dit weer opgelost" is de eerste vraag die iemand stelt.
 */
export function resolvedNote(now: Date): string {
  return `Opgelost op ${dutchDate(now)} — de dagelijkse controle vindt dit niet meer.`;
}

/** Wat een bestaande rij opnieuw krijgt bij een update of een heropening. */
export type SignalText = Pick<SignalFields, 'naam' | 'detail'>;

export interface SignalWriter {
  create(fields: SignalFields): Promise<void>;
  update(itemId: string, fields: SignalText): Promise<void>;
  reopen(itemId: string, fields: SignalText): Promise<void>;
  tick(signal: ExistingSignal): Promise<void>;
  updateSummary(itemId: string, detail: string): Promise<void>;
  move(move: GroupMove): Promise<void>;
  /** Maakt `Afgehandeld door` leeg — zie `staleClosedByMarkers`. */
  clearClosedBy(itemId: string): Promise<void>;
}

/**
 * Schrijft naar het Systeem-bord.
 *
 * **Alleen `create` krijgt een idempotency-sleutel, en dat is geen willekeur.**
 *
 * De transportlaag doet een tweede poging bij een netwerkfout en bij 429/500/502/503/504. Komt
 * de create wél aan maar gaat het antwoord verloren, dan maakt die tweede poging een tweede
 * rij — en de sleutelkolom kan dat niet opvangen, want tussen twee pogingen wordt er niets
 * teruggelezen. Precies dat scenario laat er twee identieke meldingen achter, of een tweede
 * samenvattingsrij.
 *
 * De andere schrijfacties zijn toewijzingen: `tick`, `update`, `reopen` en `updateSummary`
 * zetten een waarde die vooraf is uitgerekend, dus twee keer uitvoeren geeft hetzelfde
 * resultaat als één keer. Ook `tick` — de "Opgelost op"-regel wordt gebouwd uit `signal.detail`
 * zoals dat aan het begin van de run is gelezen, niet uit wat er nú staat, dus hij stapelt niet
 * op. `move_item_to_group` naar dezelfde groep is eveneens onschadelijk.
 *
 * De sleutel draagt het bord-id én het run-id. Het bord-id houdt een testbord en productie uit
 * elkaar — zonder dat zou Monday's cache van 30 minuten het antwoord van het ene bord op het
 * andere kunnen teruggeven. Het run-id zorgt dat de sleutel alleen bínnen deze run dedupliceert:
 * een latere run die dezelfde melding opnieuw moet aanmaken (iemand verwijderde de rij) mag daar
 * niet door tegengehouden worden.
 */
export function createSignalWriter(
  write: MondayMutationClient,
  boardId: string,
  runId: string,
  now: () => Date
): SignalWriter {
  return {
    async create(fields) {
      await write.mutate(
        CREATE_ITEM,
        {
          board: boardId,
          group: fields.groupId,
          name: fields.naam,
          // De waarden reizen mee met de create, zodat een melding nooit zonder sleutel
          // zichtbaar is — een rij zonder sleutel wordt door de volgende run genegeerd.
          values: JSON.stringify(columnValues(fields, now())),
        },
        { idempotencyKey: idempotencyKey(boardId, runId, fields.sleutel) }
      );
    },

    async update(itemId, fields) {
      await write.mutate(CHANGE_VALUES, {
        board: boardId,
        item: itemId,
        values: JSON.stringify({
          // `name` is de speciale sleutel waarmee Monday de itemnaam meeneemt in dezelfde
          // mutatie. Eén schrijfactie, dus de naam en het detail kunnen niet uiteenlopen.
          name: fields.naam,
          [SIGNAL_COLUMNS.detail]: fields.detail,
          [SIGNAL_COLUMNS.tijdstip]: tijdstip(now()),
        }),
      });
    },

    async reopen(itemId, fields) {
      await write.mutate(CHANGE_VALUES, {
        board: boardId,
        item: itemId,
        values: JSON.stringify({
          name: fields.naam,
          [SIGNAL_COLUMNS.detail]: fields.detail,
          [SIGNAL_COLUMNS.tijdstip]: tijdstip(now()),
          [SIGNAL_COLUMNS.afgehandeld]: { checked: 'false' },
          // Leegmaken, niet laten staan: hierna is de rij weer een gewone openstaande
          // melding, en wie hem dán afvinkt is een mens met een besluit.
          [SIGNAL_COLUMNS.afgehandeldDoor]: '',
        }),
      });
    },

    async tick(signal) {
      const stamp = now();
      await write.mutate(CHANGE_VALUES, {
        board: boardId,
        item: signal.itemId,
        values: JSON.stringify({
          [SIGNAL_COLUMNS.afgehandeld]: { checked: 'true' },
          [SIGNAL_COLUMNS.tijdstip]: tijdstip(stamp),
          [SIGNAL_COLUMNS.detail]: `${resolvedNote(stamp)}\n\n${signal.detail}`.trim(),
          // Wie er heeft afgevinkt. Leeg = een mens; zie `reconcile.ts` voor waarom dat
          // verschil bepaalt of de melding ooit terugkomt.
          [SIGNAL_COLUMNS.afgehandeldDoor]: CLOSED_BY_CHECK,
        }),
      });
    },

    async move(move) {
      await write.mutate(MOVE_ITEM, { item: move.itemId, group: move.groupId });
    },

    async clearClosedBy(itemId) {
      await write.mutate(CHANGE_VALUES, {
        board: boardId,
        item: itemId,
        values: JSON.stringify({ [SIGNAL_COLUMNS.afgehandeldDoor]: '' }),
      });
    },

    async updateSummary(itemId, detail) {
      await write.mutate(CHANGE_VALUES, {
        board: boardId,
        item: itemId,
        values: JSON.stringify({
          [SIGNAL_COLUMNS.tijdstip]: tijdstip(now()),
          [SIGNAL_COLUMNS.detail]: detail,
        }),
      });
    },
  };
}

/** Voert de uitkomst van `reconcile` uit, in de volgorde waarin die hem heeft gezet. */
export interface AppliedActions {
  readonly created: number;
  readonly updated: number;
  readonly resolved: number;
  readonly reopened: number;
  /** Ids die deze run zijn afgevinkt — `move.ts` heeft ze nodig. */
  readonly resolvedIds: readonly string[];
  /** Ids die deze run zijn heropend — die moeten terug naar de meldingengroep. */
  readonly reopenedIds: readonly string[];
}

export async function applyActions(
  writer: SignalWriter,
  actions: readonly SignalAction[],
  /** Waar een nieuwe melding in komt te staan: altijd de groep met wat er nog ligt. */
  openGroupId: string
): Promise<AppliedActions> {
  let created = 0;
  let updated = 0;
  const resolvedIds: string[] = [];
  const reopenedIds: string[] = [];

  for (const action of actions) {
    switch (action.kind) {
      case 'create':
        await writer.create({
          naam: action.row.naam,
          detail: action.row.detail,
          soort: action.row.soort,
          onderdeel: action.row.onderdeel,
          sleutel: action.row.key,
          groupId: openGroupId,
        });
        created += 1;
        break;
      case 'update':
        await writer.update(action.signal.itemId, action.row);
        updated += 1;
        break;
      case 'reopen':
        await writer.reopen(action.signal.itemId, action.row);
        reopenedIds.push(action.signal.itemId);
        break;
      case 'resolve':
        await writer.tick(action.signal);
        resolvedIds.push(action.signal.itemId);
        break;
    }
  }

  return {
    created,
    updated,
    resolved: resolvedIds.length,
    reopened: reopenedIds.length,
    resolvedIds,
    reopenedIds,
  };
}
