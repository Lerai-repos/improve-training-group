import { loadAgendaBoards } from '@lib/evaluations';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

import { herleesKandidaat, readKandidaten, readOpportunities } from './read';

import type { OvernameDeps, Schrijfactie } from './run';

const CHANGE_VALUES = `mutation ($board: ID!, $item: ID!, $values: JSON!) {
  change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values) { id }
}`;

/** Vandaag als `YYYY-MM-DD`, in Nederlandse tijd: de agenda staat in kalenderdagen. */
export function vandaagNL(now: Date): string {
  const delen = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const deel = (type: string): string => delen.find((d) => d.type === type)?.value ?? '';
  return `${deel('year')}-${deel('month')}-${deel('day')}`;
}

/**
 * De echte aansluitingen. De croneroute en het handmatige script bouwen hem allebei hier,
 * zodat een droogloop precies leest wat de nacht leest.
 */
export function buildOvernameDeps(options: {
  dryRun: boolean;
  deadlineMs?: () => number | null;
  now?: () => Date;
}): OvernameDeps {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN is not configured');
  }
  const client = createMondayGraphQLClient({
    token,
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: options.deadlineMs,
  });
  // Dezelfde deadline als de leesclient, zodat een trage schrijfreeks niet doorloopt tot Vercel de functie afkapt.
  const write = createMondayMutationClient({
    token,
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: options.deadlineMs,
  });
  const now = options.now ?? ((): Date => new Date());

  const writer = async (actie: Schrijfactie): Promise<void> => {
    await write.mutate(CHANGE_VALUES, {
      board: actie.boardId,
      item: actie.itemId,
      values: JSON.stringify(actie.waarden),
    });
  };

  return {
    readAgendaBoards: () => loadAgendaBoards(client),
    readKandidaten: (board) => readKandidaten(client, board, vandaagNL(now())),
    readOpportunities: (ids) => readOpportunities(client, ids),
    herlees: (rij) => herleesKandidaat(client, rij),
    writer: options.dryRun ? null : writer,
  };
}
