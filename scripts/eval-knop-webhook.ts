/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { liveAgendaBoards, loadAgendaBoards } from '@lib/evaluations';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { EVAL_STATUS_COLUMN, EVAL_STATUS_INDEX } from '@lib/report/knop';
import {
  EVAL_STATUS_EVENT,
  isEvalStatusWebhook,
  teVerwijderen,
} from '@lib/report/knop-webhook-sync';

import type { WebhookRij } from '@lib/report/knop-webhook-sync';

/**
 * De knop Eval Rapport aansluiten op deze app, in plaats van op n8n.
 *
 *   pnpm eval:knop-webhook            # droogloop: laat per agendabord zien wat er staat
 *   pnpm eval:knop-webhook --apply    # onze webhook aanmaken, de andere op Eval Status weg
 *
 * Per actief agendabord met de kolom `Eval Status`. **Pas NA de deploy draaien**: Monday roept
 * bij het aanmaken meteen de route aan (de challenge), en zonder route mislukt het aanmaken.
 * `PUBLIC_BASE_URL` moet dus de productie-URL zijn.
 *
 * Eerst aanmaken, dán opruimen: mislukt het aanmaken, dan blijft de oude staan en is er niets
 * kapot dat er niet al kapot was. Herhaalbaar: een tweede keer maakt een nieuwe en ruimt de
 * vorige op, zodat er altijd precies één webhook op `Eval Status` overblijft.
 */

const EXIT_FAILURE = 1;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN ontbreekt');
  }
  const base = (process.env.PUBLIC_BASE_URL ?? '').trim().replace(/\/$/, '');
  const geheim = (process.env.MONDAY_WEBHOOK_TOKEN ?? '').trim();
  if (apply && (base === '' || geheim === '')) {
    throw new Error('PUBLIC_BASE_URL en MONDAY_WEBHOOK_TOKEN zijn nodig voor --apply.');
  }
  const pad = '/api/webhooks/monday/eval-rapport';

  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });

  const borden = liveAgendaBoards(await loadAgendaBoards(read)).filter(
    (b) => b.columnTypes[EVAL_STATUS_COLUMN] !== undefined
  );
  console.log(
    `\nKnop Eval Rapport — ${apply ? 'APPLY' : 'droogloop'} — doel: ${base || '(PUBLIC_BASE_URL leeg)'}${pad}\n`
  );
  if (borden.length === 0) {
    console.log('  Geen actief agendabord met de kolom Eval Status.\n');
    return;
  }

  for (const bord of borden) {
    const lezen = async (): Promise<readonly WebhookRij[]> =>
      (
        await read.query<{ webhooks: WebhookRij[] | null }>(
          'query ($b: ID!) { webhooks(board_id: $b, app_webhooks_only: false) { id event config } }',
          { b: bord.boardId }
        )
      ).webhooks ?? [];

    const huidig = (await lezen()).filter(isEvalStatusWebhook);
    console.log(`  ${bord.naam} (${bord.boardId})`);
    console.log(
      `    nu op Eval Status: ${huidig.length === 0 ? 'geen' : huidig.map((w) => w.id).join(', ')}`
    );
    if (!apply) {
      console.log('    zou: onze webhook aanmaken en deze weghalen\n');
      continue;
    }

    const gemaakt = await write.mutate<{ create_webhook: { id: string } }>(
      `mutation ($b: ID!, $url: String!, $event: WebhookEventType!, $config: JSON) {
         create_webhook(board_id: $b, url: $url, event: $event, config: $config) { id }
       }`,
      {
        b: bord.boardId,
        url: `${base}${pad}?token=${geheim}`,
        event: EVAL_STATUS_EVENT,
        config: JSON.stringify({
          columnId: EVAL_STATUS_COLUMN,
          columnValue: { index: EVAL_STATUS_INDEX.run },
        }),
      }
    );
    const nieuw = String(gemaakt.create_webhook.id);
    console.log(`    aangemaakt: ${nieuw}`);

    /**
     * Een webhook die niet via onze sleutel is aangemaakt (n8n's, als automatisering in de
     * Monday-UI gezet) mag deze sleutel niet verwijderen; Monday antwoordt dan met een
     * "Internal server error". Overslaan en zeggen waar hij met de hand weg moet, in plaats van
     * af te breken — afbreken liet bij een herhaling een tweede eigen webhook achter.
     */
    for (const id of teVerwijderen(await lezen(), nieuw)) {
      try {
        await write.mutate('mutation ($id: ID!) { delete_webhook(id: $id) { id } }', { id });
        console.log(`    verwijderd: ${id}`);
      } catch (error) {
        console.log(
          `    NIET verwijderd: ${id} (${error instanceof Error ? error.message : String(error)})` +
            '\n      Niet door deze sleutel aangemaakt. Haal hem weg in Monday: bord → Integreren' +
            ' → de automatisering "Eval Status → RUN → webhook" die naar n8n wijst.'
        );
      }
    }
    console.log('');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(EXIT_FAILURE);
});
