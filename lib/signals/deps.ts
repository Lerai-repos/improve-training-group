import { randomUUID } from 'node:crypto';

import { labelsBoardId } from '@lib/labels';
import { createRedisClient, createUpstashKvStore } from '@lib/recommend/kv';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

import { systeemBoardId } from './board';
import { SIGNAL_GROUPS } from './groups';
import { readAgendaUsage, readLabelsForCheck, readSignals, readThemas, readTrainers } from './read';
import { createSignalWriter } from './write';

import type { SignalGroupIds } from './groups';
import type { LeaseDeps } from './lease';
import type { DailyCheckDeps } from './run';

/**
 * De echte aansluitingen voor de dagelijkse controle.
 *
 * Zowel de croneroute als het handmatige script bouwen hem hier, zodat een droogloop precies
 * leest wat de nacht leest. Zelfde patroon als `buildDailyReportDeps`.
 */
/**
 * De grendel die runs op hetzelfde bord serialiseert.
 *
 * Zelfde Redis als de rest van de motor. Een eigen token per aanroep, zodat alleen de houder
 * vrijgeeft — zie `withBoardLease`.
 */
export function buildSignalLease(): LeaseDeps {
  return {
    kv: createUpstashKvStore(createRedisClient()),
    token: () => randomUUID(),
    now: () => Date.now(),
  };
}

export function buildDailyCheckDeps(options: {
  /** Droogloop: alles lezen en berekenen, niets schrijven. */
  dryRun: boolean;
  /** De drie groep-ids van het bord, opgezocht met `signalGroups`. */
  groups: SignalGroupIds;
  deadlineMs?: () => number | null;
  /**
   * Onderscheidt deze run van elke andere, en zit in de idempotency-sleutel van een create.
   * Meegeefbaar zodat een test hem vast kan zetten.
   */
  runId?: string;
}): { deps: DailyCheckDeps; boardId: string } {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN is not configured');
  }

  const client = createMondayGraphQLClient({
    token,
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: options.deadlineMs,
  });
  /**
   * De schrijfclient krijgt DEZELFDE deadline als de leesclient.
   *
   * Zonder dat kan een reeks trage of hernieuwde schrijfacties gewoon doorlopen nadat de
   * looptijdgrens van de route al is gepasseerd, tot Vercel de functie middenin het
   * bijwerken afkapt — en dan is er van alles half gedaan zonder dat er iets gemeld wordt.
   */
  const write = createMondayMutationClient({
    token,
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: options.deadlineMs,
  });
  const boardId = systeemBoardId();
  const runId = options.runId ?? `run-${Date.now()}`;
  const now = (): Date => new Date();

  return {
    boardId,
    deps: {
      readSignals: () => readSignals(client, boardId),
      readAgendaUsage: () => readAgendaUsage(client),
      // De DIAGNOSTISCHE lezer, met opzet niet `readLabels` — zie `readLabelsForCheck`.
      readLabels: () => readLabelsForCheck(client, labelsBoardId()),
      readThemas: () => readThemas(client),
      readTrainers: () => readTrainers(client),
      writer: options.dryRun ? null : createSignalWriter(write, boardId, runId, now),
      groups: options.groups,
      now,
    },
  };
}

/**
 * De ids van de drie groepen, opgezocht op titel.
 *
 * **Werpt bij een ontbrekende groep in plaats van terug te vallen op de eerste.** Zo'n
 * terugval zou alle drie de soorten rijen op één hoop gooien — precies het bord dat deze
 * indeling moet voorkomen — en het zou er normaal uitzien. Hernoemt iemand een groep, dan
 * hoort de controle te klagen, niet te raden.
 */
export async function signalGroups(
  client: ReturnType<typeof createMondayGraphQLClient>,
  boardId: string
): Promise<SignalGroupIds> {
  const meta = await client.getSchema([boardId]);
  const groups = meta[0]?.groups ?? [];

  const find = (title: string): string => {
    const group = groups.find((g) => g.title === title);
    if (group === undefined) {
      const aanwezig = groups.map((g) => `"${g.title}"`).join(', ');
      throw new Error(
        `Bord ${boardId} heeft geen groep "${title}". Aanwezig: ${aanwezig === '' ? 'geen' : aanwezig}.\n` +
          'Hernoem de groep terug of draai `pnpm systeem:create --apply` om hem aan te maken.'
      );
    }
    return group.id;
  };

  return {
    samenvatting: find(SIGNAL_GROUPS.samenvatting),
    open: find(SIGNAL_GROUPS.open),
    afgehandeld: find(SIGNAL_GROUPS.afgehandeld),
  };
}
