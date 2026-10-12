import {
  agendaBoardOverride,
  agendaBoardsToConnect,
  discoverAgendaBoards,
  liveAgendaBoards,
} from '@lib/evaluations';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { currentDeadlineMs, publicBaseUrl } from '@lib/recommend';
import { createRedisClient, createUpstashKvStore } from '@lib/recommend/kv';
import { parseCreatedWebhookId, parseWebhookRows } from '@lib/recommend/webhook-sync';

import { EVAL_STATUS_COLUMN, EVAL_STATUS_INDEX } from './knop';
import { EVAL_STATUS_EVENT } from './knop-webhook-sync';

import type { KvStore } from '@lib/recommend/kv';
import type { KnopWebhookStore, KnopWebhookSyncDeps } from './knop-webhook-sync';

/** Zonder verloop: een abonnement verloopt ook niet. */
export function createKnopWebhookStore(kv: KvStore): KnopWebhookStore {
  const key = (boardId: string): string => `evalknop-webhook:v1:${boardId}`;
  return {
    read: (boardId) => kv.get(key(boardId)),
    write: (boardId, webhookId) => kv.set(key(boardId), webhookId),
  };
}

/** De webhook-URL van de knop, met het gedeelde geheim erin (ook voor de challenge). */
export function evalKnopWebhookUrl(base: string, geheim: string): string {
  return `${base}/api/webhooks/monday/eval-rapport?token=${geheim}`;
}

/** `create_webhook` voor Eval Status → RUN. */
export const CREATE_EVAL_KNOP_WEBHOOK = `mutation ($b: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
  create_webhook(board_id: $b, url: $url, event: $event, config: $config) { id }
}`;

export const EVAL_KNOP_WEBHOOK_CONFIG = JSON.stringify({
  columnId: EVAL_STATUS_COLUMN,
  columnValue: { index: EVAL_STATUS_INDEX.run },
});

/** De echte aansluitingen voor het uurlijkse aansluiten van de knop. */
export function buildKnopWebhookSyncDeps(options: { dryRun: boolean }): KnopWebhookSyncDeps {
  const token = process.env.MONDAY_API_TOKEN;
  const geheim = process.env.MONDAY_WEBHOOK_TOKEN;
  if (!token || !geheim) {
    throw new Error('MONDAY_API_TOKEN en MONDAY_WEBHOOK_TOKEN zijn nodig');
  }
  const client = createMondayGraphQLClient({
    token,
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: currentDeadlineMs,
  });
  const write = createMondayMutationClient({
    token,
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: currentDeadlineMs,
  });
  const url = evalKnopWebhookUrl(publicBaseUrl(), geheim);

  return {
    boards: async () =>
      /** Niet `loadAgendaBoards`: een ontbrekend oud jaar mag 2027 niet blokkeren. */
      liveAgendaBoards(
        agendaBoardsToConnect(await discoverAgendaBoards(client), agendaBoardOverride())
      )
        .filter((b) => b.columnTypes[EVAL_STATUS_COLUMN] !== undefined)
        .map((b) => ({ boardId: b.boardId, naam: b.naam })),
    listWebhooks: async (boardId) =>
      parseWebhookRows(
        await client.query<unknown>(
          'query ($b: ID!) { webhooks(board_id: $b, app_webhooks_only: false) { id event config } }',
          { b: boardId }
        )
      ),
    createWebhook: async (boardId, replaces) =>
      parseCreatedWebhookId(
        await write.mutate<unknown>(
          CREATE_EVAL_KNOP_WEBHOOK,
          { b: boardId, url, event: EVAL_STATUS_EVENT, config: EVAL_KNOP_WEBHOOK_CONFIG },
          /**
           * Een herhaalde poging na een verloren antwoord geeft zo het eerste id terug in
           * plaats van een tweede webhook. Het vervangen id zit erin, zodat een nieuwe
           * aanmaak na een verdwenen webhook niet het oude id terugkrijgt.
           */
          { idempotencyKey: `evalknop-webhook:${boardId}:${replaces ?? 'nieuw'}` }
        )
      ),
    store: createKnopWebhookStore(createUpstashKvStore(createRedisClient())),
    dryRun: options.dryRun,
  };
}
