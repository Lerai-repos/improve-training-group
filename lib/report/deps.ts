import {
  createOAuthGoogleAuth,
  evaluationDocuments,
  googleSheetsSource,
  liveAgendaBoards,
  loadAgendaBoards,
  oauthCredentialsFromEnv,
  readAgendaHistory,
  type AgendaBoardSet,
  type BoardsQueryClient,
} from '@lib/evaluations';
import { labelsBoardId } from '@lib/labels';
import {
  createFailureStore,
  createGraphMailSender,
  createSentGuard,
  deadlineSignal,
  deliveryNamespace,
  isRedirected,
  mailRecipients,
} from '@lib/mail';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { readLabels } from '@lib/labels/read';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import { createRedisClient, createUpstashKvStore } from '@lib/recommend/kv';
import { createGraphClient, graphConfigFromEnv } from '@lib/sharepoint/graph';

import { readTrainingForReport } from './training';
import { readTrainerEmails } from './trainer-emails';

import { createPdfRenderer } from './pdf';

import type { DailyDeps, DailyMailDeps } from './daily';
import type { ReportRunDeps } from './run';

/**
 * De echte verzendkant: Graph voor de mail, Chromium voor het rapport, Redis voor de grendel.
 *
 * Dezelfde Graph-app als de briefingupload — het recht om te mailen komt uit een
 * Exchange-roltoewijzing op één postvak, niet uit een Entra-permissie. Werpt als de
 * omgevingsvariabelen ontbreken, en dat is de bedoeling: een dagjob die stilletjes niet mailt
 * omdat er een sleutel weg is, is er een waar niemand achter komt.
 *
 * ## De looptijdgrens wordt LAAT opgehaald, niet hier
 *
 * `currentDeadlineMs` leest uit `AsyncLocalStorage`, en de route bouwt deze deps vóórdat hij
 * `runWithDeadline` binnengaat. Wie hem hier meteen uitleest krijgt dus `null` en geeft Graph
 * helemaal geen afbreeksignaal mee — waarna een vastgelopen upload doorloopt tot Vercel de
 * functie afkapt. Dán is er geen `catch` meer, dus ook geen `release`, en blijft de claim
 * staan zonder dat er iets verstuurd is.
 *
 * En het is een ABSOLUUT tijdstip, geen resterende duur. Dat rechtstreeks aan
 * `AbortSignal.timeout` geven levert een tijdslimiet van tienduizenden jaren op: een signaal
 * dat er is en nooit afgaat, wat erger is dan geen signaal, want het ziet eruit als dekking.
 */
function buildMailDeps(
  client: Parameters<typeof readTrainerEmails>[0],
  deadlineMs?: () => number | null
): DailyMailDeps {
  const signalNu = (): AbortSignal | undefined => deadlineSignal(() => deadlineMs?.() ?? null);

  const config = graphConfigFromEnv();

  /**
   * De client komt er pas bij de eerste aanroep, en dat is bewust.
   *
   * Tegen die tijd loopt de run wél binnen `runWithDeadline`, dus dan pas is er een echte
   * grens om mee te geven. Eén client voor de hele run, zodat het token hergebruikt wordt in
   * plaats van per mail opnieuw opgehaald.
   */
  let graph: ReturnType<typeof createGraphClient> | null = null;
  const lazyGraph = {
    json: (pad: string, init?: RequestInit): Promise<unknown> => {
      graph ??= createGraphClient(config, { signal: signalNu() });
      return graph.json(pad, init);
    },
  };

  const recipients = mailRecipients();
  /** Eén ruimte voor de grendel én de meldingen; zie `deliveryNamespace`. */
  const namespace = deliveryNamespace({ ...recipients, redirected: isRedirected(recipients) });

  return {
    recipients,
    sender: createGraphMailSender({
      client: lazyGraph,
      sender: recipients.sender,
      /**
       * De brokken gaan buiten de Graph-client om, naar een vooraf geautoriseerde URL. Zonder
       * deze regel draagt juist de traagste stap van allemaal geen grens.
       */
      uploadFetch: (url, init) => fetch(url, { ...init, signal: signalNu() }),
    }),
    /**
     * De grendel krijgt een eigen ruimte zodra de bestemming is omgeleid.
     *
     * Anders blokkeert één geslaagde testverzending naar je eigen adres de échte levering aan
     * `aanvragen@` en `backoffice@` — en dat is precies wat er gebeurt bij de eerste keer dat
     * iemand dit voorzichtig uitprobeert.
     */
    failures: createFailureStore(createUpstashKvStore(createRedisClient()), namespace),
    guard: createSentGuard(createRedisClient(), namespace),
    /** Mét de looptijdgrens: Chromium is de traagste stap en had er als enige geen. */
    renderer: createPdfRenderer(deadlineMs),
    readTrainerEmails: (ids) => readTrainerEmails(client, ids),
    nowMs: () => Date.now(),
  };
}

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
  /**
   * Of de mails de deur uit mogen.
   *
   * Geen standaardwaarde: elke aanroeper zegt het hardop. Een verstuurde mail is niet terug
   * te nemen, en dat verdient geen impliciete keuze in een hulpfunctie.
   */
  mail: boolean;
}): { deps: DailyDeps } {
  const { date, deadlineMs } = options;
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN is not configured');
  }

  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION, deadlineMs });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });
  const boards = agendaBoardsOnce(client);

  return {
    deps: {
      mail: options.mail ? buildMailDeps(client, deadlineMs) : undefined,
      readAgenda: async () => {
        const set = await boards();
        const live = new Set(liveAgendaBoards(set).map((b) => b.boardId));
        return (await readAgendaHistory(client, set.boards)).trainings.map((t) => ({
          trainingItemId: t.entry.trainingItemId,
          datum: t.entry.datum,
          boardId: t.boardId,
          live: live.has(t.boardId),
          ref: t.ref,
        }));
      },
      readTraining: async (id) => readTrainingForReport(client, id, (await boards()).boards),
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
      writeColumns: async (itemId, boardId, values) => {
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
 * De agendaborden één keer per run ontdekken, en dan delen.
 *
 * De agendalezer en elke trainingslezer hebben ze nodig, en ontdekken kost een paar
 * Monday-vragen: niet per training opnieuw. Een mislukte poging wordt niet bewaard, zodat de
 * volgende aanroep het opnieuw probeert in plaats van dezelfde fout te herhalen.
 */
function agendaBoardsOnce(client: BoardsQueryClient): () => Promise<AgendaBoardSet> {
  let pending: Promise<AgendaBoardSet> | null = null;
  return () => {
    if (pending === null) {
      const attempt = loadAgendaBoards(client);
      pending = attempt;
      attempt.catch(() => {
        if (pending === attempt) {
          pending = null;
        }
      });
    }
    return pending;
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
  const boards = agendaBoardsOnce(client);

  return {
    readTraining: async (id) => readTrainingForReport(client, id, (await boards()).boards),
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
      (await readAgendaHistory(client, (await boards()).boards)).trainings.map((t) => t.ref),
    renderer: createPdfRenderer(deadlineMs),
  };
}
