/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { AGENDA_2026_COLUMNS, MONDAY_API_VERSION, agendaBoardId } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { trainerRelationIds } from '@lib/monday/decode';
import { readAgendaScan } from '@lib/recommend/assignments';
import { readBriefingTraining } from '@lib/briefing/read';
import { siteConfigFromEnv } from '@lib/sharepoint/config';
import { createGraphClient, graphConfigFromEnv } from '@lib/sharepoint/graph';
import { sanitiseItemName, yearOfDate } from '@lib/sharepoint/paths';
import { resolveBriefingLocation } from '@lib/sharepoint/resolve';
import { createSharePointStore, resolveSiteId } from '@lib/sharepoint/store';

import type { FolderLister } from '@lib/sharepoint/resolve';

/**
 * Waar zou elke komende briefing terechtkomen?
 *
 * Leest alleen. Dit is het laatste stuk van de keten dat nooit tegen de echte omgeving
 * heeft gedraaid: tot vandaag was er geen toegang, dus de mapresolutie kende alleen
 * verzonnen mappenbomen. Per training één `resolveBriefingLocation`, en dan tellen hoe
 * vaak de klantmap er al staat, hoe vaak wij hem zouden aanmaken, en waar de structuur
 * anders is dan de code verwacht.
 */

const GELIJKTIJDIG = 4;

/**
 * Eén map wordt tientallen keren opgevraagd — elke training vraagt dezelfde label- en
 * klantenmap op. Zonder cache is dit duizenden Graph-verzoeken voor een paar honderd
 * antwoorden, en Graph gaat dan throttelen.
 */
function cachedLister(inner: FolderLister): FolderLister {
  const cache = new Map<string, Promise<readonly string[]>>();
  return {
    children(path: string): Promise<readonly string[]> {
      const gecached = cache.get(path);
      if (gecached !== undefined) {
        return gecached;
      }
      const belofte = inner.children(path);
      cache.set(path, belofte);
      return belofte;
    },
  };
}

interface Rij {
  itemId: string;
  naam: string;
  label: string;
  klant: string;
  jaar: string | null;
  uitkomst: 'bestaat' | 'nieuw' | 'geweigerd' | 'leesfout' | 'geen_klant';
  detail: string;
}

async function main(): Promise<void> {
  const losseArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const vanaf = losseArgs[0] ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(vanaf)) {
    throw new Error(`Begindatum moet YYYY-MM-DD zijn, kreeg ${JSON.stringify(vanaf)}`);
  }

  const boardId = agendaBoardId();
  const monday = createMondayGraphQLClient({
    token: process.env.MONDAY_API_TOKEN ?? '',
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: () => Date.now() + 180_000,
  });

  const site = siteConfigFromEnv();
  const graph = createGraphClient(graphConfigFromEnv());
  const store = createSharePointStore(graph, await resolveSiteId(graph, site));
  const lister = cachedLister(store);

  const scan = await readAgendaScan(monday, {
    boardId,
    dateColumnId: AGENDA_2026_COLUMNS.datum,
    trainerColumnIds: trainerRelationIds(AGENDA_2026_COLUMNS),
  });
  const ids = [...scan.dateByItemId]
    .filter(([, datum]) => datum !== null && datum >= vanaf)
    .sort((a, b) => (a[1] ?? '').localeCompare(b[1] ?? ''))
    .map(([id]) => id);

  console.log(`Bord ${boardId}: ${ids.length} komende trainingen vanaf ${vanaf}`);
  console.log(`Site ${site.host}${site.path}, wortel "${site.root}"\n`);

  const rijen: Rij[] = [];
  for (let i = 0; i < ids.length; i += GELIJKTIJDIG) {
    const groep = ids.slice(i, i + GELIJKTIJDIG);
    rijen.push(
      ...(await Promise.all(
        groep.map(async (itemId): Promise<Rij> => {
          let training;
          try {
            training = await readBriefingTraining(monday, itemId, { boardId });
          } catch (error) {
            return {
              itemId,
              naam: '?',
              label: '?',
              klant: '?',
              jaar: null,
              uitkomst: 'leesfout',
              detail: error instanceof Error ? error.message : String(error),
            };
          }
          const jaar = yearOfDate(training.datum);
          const basis = {
            itemId,
            naam: training.naam,
            label: training.label,
            klant: training.opdrachtgever,
            jaar,
          };

          /**
           * Altijd de echte resolver, ook als de klantnaam leeg is.
           *
           * De verleiding is om hier vóór de aanroep te controleren, maar dan meet dit
           * script zijn eigen controle in plaats van de weigering die straks in productie
           * draait. De ontbrekende klant is dus een MANIER waarop de resolver weigert, geen
           * reden om hem over te slaan — vandaar dat de indeling na afloop gebeurt.
           */
          const uit = await resolveBriefingLocation(lister, {
            root: site.root,
            label: training.label,
            klant: training.opdrachtgever,
            jaar,
          });
          if (uit.kind === 'refused') {
            /**
             * `label` en `opdrachtgever` zijn `string`, nooit `null`: een lege cel komt als
             * `''` binnen. Een `=== null`-controle is hier dus altijd onwaar en de emmer
             * blijft leeg — precies de reden dat de vorige versie trots `GEEN KLANTNAAM: 0`
             * rapporteerde terwijl het er tien waren.
             */
            const zonderKlant = sanitiseItemName(training.opdrachtgever) === '';
            return {
              ...basis,
              uitkomst: zonderKlant ? 'geen_klant' : 'geweigerd',
              detail: uit.reason,
            };
          }
          return {
            ...basis,
            uitkomst: uit.location.exists ? 'bestaat' : 'nieuw',
            detail: uit.location.path,
          };
        })
      ))
    );
    process.stderr.write(`\r  ${rijen.length}/${ids.length}`);
  }
  process.stderr.write('\n\n');

  const tel = (soort: Rij['uitkomst']): Rij[] => rijen.filter((r) => r.uitkomst === soort);
  console.log(`KLANTMAP BESTAAT:  ${tel('bestaat').length}`);
  console.log(`MAP AAN TE MAKEN:  ${tel('nieuw').length}`);
  console.log(`GEWEIGERD:         ${tel('geweigerd').length}`);
  console.log(`GEEN KLANTNAAM:    ${tel('geen_klant').length}`);
  console.log(`LEESFOUT:          ${tel('leesfout').length}\n`);

  for (const rij of tel('geen_klant')) {
    console.log(`  GEEN KLANT  ${rij.itemId}  ${rij.label.padEnd(5)} ${rij.naam.slice(0, 60)}`);
  }

  const perLabel = new Map<string, { bestaat: number; nieuw: number; geweigerd: number }>();
  for (const rij of rijen) {
    const huidig = perLabel.get(rij.label) ?? { bestaat: 0, nieuw: 0, geweigerd: 0 };
    if (rij.uitkomst !== 'leesfout' && rij.uitkomst !== 'geen_klant') {
      huidig[rij.uitkomst] += 1;
    }
    perLabel.set(rij.label, huidig);
  }
  console.log('Per label (bestaat / nieuw / geweigerd):');
  for (const [label, t] of [...perLabel].sort()) {
    console.log(`  ${label.padEnd(6)} ${t.bestaat} / ${t.nieuw} / ${t.geweigerd}`);
  }

  const nieuw = tel('nieuw');
  if (nieuw.length > 0) {
    console.log(`\nMappen die wij zouden aanmaken (${nieuw.length}):`);
    for (const rij of nieuw.slice(0, 40)) {
      console.log(`  ${rij.detail}`);
    }
    if (nieuw.length > 40) {
      console.log(`  ... en nog ${nieuw.length - 40}`);
    }
  }

  const geweigerd = tel('geweigerd');
  if (geweigerd.length > 0) {
    console.log(`\nGeweigerd (${geweigerd.length}):`);
    for (const rij of geweigerd) {
      console.log(
        `  ${rij.label.padEnd(5)} ${rij.klant.slice(0, 34).padEnd(36)} ${rij.detail.slice(0, 110)}`
      );
    }
  }

  const fouten = tel('leesfout');
  if (fouten.length > 0) {
    console.log(`\nLeesfouten (${fouten.length}):`);
    for (const rij of fouten) {
      console.log(`  ${rij.itemId}  ${rij.detail.slice(0, 120)}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
