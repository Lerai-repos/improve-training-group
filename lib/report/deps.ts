import {
  createOAuthGoogleAuth,
  evaluationDocuments,
  googleSheetsSource,
  oauthCredentialsFromEnv,
  readAgendaHistory,
} from '@lib/evaluations';
import { labelsBoardId } from '@lib/labels';
import { readLabels } from '@lib/labels/read';
import { agendaBoardId, MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

import { reportAgendaBoards } from './agenda-boards';
import { readTrainingForReport } from './training';

import { createPdfRenderer } from './pdf';

import type { DailyDeps } from './daily';
import type { ReportRunDeps } from './run';

/**
 * De echte aansluitingen voor de dagjob, op één plek.
 *
 * Zowel de croneroute als het droogloopscript bouwen hem hier — een handmatige controle die
 * net iets anders is aangesloten dan de nachtelijke job controleert niet wat er 's ochtends
 * gebeurt. Zelfde patroon als `buildEvalStatsDeps`.
 *
 * `deadlineMs` wordt doorgegeven zodat de looptijdgrens van de route ook Google en Monday
 * bereikt; zonder dat kan een fetch de route overleven en hem zijn nette mislukking afnemen.
 */
export function buildDailyReportDeps(options: {
  /** De dag die verwerkt wordt; zit in de idempotency-sleutel. */
  date: string;
  deadlineMs?: () => number | null;
}): { deps: DailyDeps; boardId: string } {
  const { date, deadlineMs } = options;
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN is not configured');
  }

  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION, deadlineMs });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });
  const boardId = agendaBoardId();

  return {
    boardId,
    deps: {
      readAgenda: async () =>
        (await readAgendaHistory(client, reportAgendaBoards())).trainings.map((t) => ({
          trainingItemId: t.entry.trainingItemId,
          datum: t.entry.datum,
          boardId: t.boardId,
          ref: t.ref,
        })),
      readTraining: (id) => readTrainingForReport(client, id),
      readLabels: () => readLabels(client, labelsBoardId()),
      readResponses: async () =>
        (
          await googleSheetsSource(
            createOAuthGoogleAuth(oauthCredentialsFromEnv(), fetch, deadlineMs),
            evaluationDocuments(),
            fetch,
            deadlineMs
          ).readResponses()
        ).responses,
      writeColumns: async (itemId, values) => {
        await write.mutate(
          `mutation ($board: ID!, $item: ID!, $values: JSON!) {
             change_multiple_column_values(board_id: $board, item_id: $item,
                                           column_values: $values) { id }
           }`,
          { board: boardId, item: itemId, values: JSON.stringify(values) }
          /**
           * BEWUST GEEN idempotency-sleutel.
           *
           * Monday bewaart het antwoord op een sleutel 30 minuten en herhaalt dat antwoord
           * zonder de mutatie opnieuw uit te voeren. Een sleutel op datum+item leek net
           * veilig, maar hij breekt precies het herstelgeval: schrijft de eerste run
           * `Onvindbaar` en komen de reacties tien minuten later alsnog binnen, dan krijgt
           * de herstelrun het gecachte antwoord en verandert er niets — met een verkeerde
           * waarde op het bord als resultaat.
           *
           * Deze schrijfactie is uit zichzelf al idempotent: het is een toewijzing, geen
           * optelling. Twee keer dezelfde waarde zetten is een no-op. De sleutel beschermde
           * dus niets en kon wel schaden.
           */
        );
      },
    },
  };
}

/**
 * De aansluitingen voor ÉÉN rapport: de route en het script, uit dezelfde bron.
 *
 * Bestond eerder twee keer los, en dat is precies waar de bordoverride uit beeld raakte:
 * de dagjob las `reportAgendaBoards()` terwijl deze twee de vaste productieborden lazen. Met
 * de override aan vond de lezer het item op de kopie, terwijl de toekenning dat item nooit
 * zag — waarna de route netjes `no_responses` meldde over een training met reacties.
 */
export function buildReportRunDeps(deadlineMs?: () => number | null): ReportRunDeps {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN is not configured');
  }
  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION, deadlineMs });

  return {
    readTraining: (id) => readTrainingForReport(client, id),
    readLabel: async (code) => (await readLabels(client, labelsBoardId())).get(code) ?? null,
    readResponses: async () =>
      (
        await googleSheetsSource(
          createOAuthGoogleAuth(oauthCredentialsFromEnv(), fetch, deadlineMs),
          evaluationDocuments(),
          fetch,
          deadlineMs
        ).readResponses()
      ).responses,
    readTrainings: async () =>
      (await readAgendaHistory(client, reportAgendaBoards())).trainings.map((t) => t.ref),
    renderer: createPdfRenderer(),
  };
}
