import { OPPORTUNITY_BOARD, OPPORTUNITY_COLUMNS } from '@lib/briefing/columns';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

import { leesAlleOpportunities, leesOpportunity, leesWebsites } from './read';

import type { InventarisatieDeps } from './run';

const ZET_LINK = `mutation ($board: ID!, $item: ID!, $column: String!, $value: JSON!) {
  change_column_value(board_id: $board, item_id: $item, column_id: $column, value: $value) { id }
}`;

/**
 * De link als waarde voor Monday. De URL is ook de zichtbare tekst: de accountmanager kopieert
 * hem uit de cel om naar de klant te sturen, en een nette naam zou de link zelf verbergen.
 */
export function linkWaarde(link: string | null): Record<string, string> {
  return link === null ? {} : { url: link, text: link };
}

/** De echte aansluitingen; de webhook, de nachtelijke ronde en het script bouwen hem hier. */
export function buildInventarisatieDeps(options: {
  dryRun: boolean;
  deadlineMs?: () => number | null;
}): InventarisatieDeps {
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

  return {
    dryRun: options.dryRun,
    websites: () => leesWebsites(read),
    leesOpportunity: (itemId) => leesOpportunity(read, itemId),
    leesAlle: () => leesAlleOpportunities(read),
    schrijf: async (itemId, link) => {
      await write.mutate(ZET_LINK, {
        board: OPPORTUNITY_BOARD,
        item: itemId,
        column: OPPORTUNITY_COLUMNS.inventarisatie,
        value: JSON.stringify(linkWaarde(link)),
      });
    },
  };
}
