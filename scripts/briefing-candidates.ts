/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { AGENDA_2026_COLUMNS, MONDAY_API_VERSION, agendaBoardId } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { trainerRelationIds } from '@lib/monday/decode';
import { readAgendaScan } from '@lib/recommend/assignments';
import { readBriefingTraining } from '@lib/briefing/read';
import { buildTabView } from '@lib/briefing/tab';
import { plannedFilenames } from '@lib/briefing/generate';
import { prefillTrainingActor, EMPTY_CHECKLIST } from '@lib/briefing/blocks';
import { countLinkedActors } from '@lib/briefing/compose';
import { siteConfigFromEnv } from '@lib/sharepoint/config';
import { createGraphClient, graphConfigFromEnv } from '@lib/sharepoint/graph';
import { yearOfDate } from '@lib/sharepoint/paths';
import { planBriefings } from '@lib/sharepoint/publish';
import { createSharePointStore, resolveSiteId } from '@lib/sharepoint/store';

import type { BriefingStore } from '@lib/sharepoint/store';

/**
 * Kandidaten voor de EERSTE echte Genereren-klik.
 *
 * Leest alleen. Combineert wat de app-tab zou beslissen met wat er in SharePoint staat, en
 * sorteert daar vier scenario's uit: de simpelste eerste klik, eentje die een map moet
 * aanmaken, eentje waar al een briefing ligt (de bevestigingsstap), en eentje met meerdere
 * ontvangers.
 */

const GELIJKTIJDIG = 4;

/**
 * Dezelfde map wordt tientallen keren opgevraagd — elke training van een label vraagt
 * dezelfde label- en klantenmap op. Zonder cache zijn dat duizenden Graph-verzoeken en gaat
 * Graph throttelen. De schrijfmethoden delegeren zonder cache; dit script roept ze nooit aan.
 */
function cachedStore(inner: BriefingStore): BriefingStore {
  const mappen = new Map<string, Promise<readonly string[]>>();
  const bestanden = new Map<string, Promise<readonly string[]>>();
  const via = (
    cache: Map<string, Promise<readonly string[]>>,
    sleutel: string,
    haal: () => Promise<readonly string[]>
  ): Promise<readonly string[]> => {
    const gecached = cache.get(sleutel);
    if (gecached !== undefined) {
      return gecached;
    }
    const belofte = haal();
    cache.set(sleutel, belofte);
    return belofte;
  };
  return {
    children: (pad) => via(mappen, pad, () => inner.children(pad)),
    files: (pad) => via(bestanden, pad, () => inner.files(pad)),
    find: (map, naam) => inner.find(map, naam),
    createFolder: (ouder, naam) => inner.createFolder(ouder, naam),
    upload: (map, naam, bytes) => inner.upload(map, naam, bytes),
  };
}

interface Kandidaat {
  itemId: string;
  naam: string;
  label: string;
  klant: string;
  datum: string | null;
  kanGenereren: boolean;
  blokkeert: readonly string[];
  documenten: number;
  rollen: readonly string[];
  legeVelden: number;
  mapPad: string | null;
  mapBestaat: boolean;
  /**
   * De GEPLANDE namen die er al liggen — precies wat de bevestigingsstap triggert.
   *
   * Niet "er staat iets in de map". Productie botst alleen op een naam die het nú zou
   * schrijven, dus een map vol offertes botst niet, en een oudere briefing met een andere
   * datum in de naam evenmin. Op mapinhoud tellen zette trainingen in de verkeerde bak.
   */
  conflicts: readonly string[];
  /** Briefings voor dezelfde klant met een andere datum. Context, geen botsing. */
  related: readonly string[];
}

async function main(): Promise<void> {
  const vanaf = new Date().toISOString().slice(0, 10);
  const boardId = agendaBoardId();
  const monday = createMondayGraphQLClient({
    token: process.env.MONDAY_API_TOKEN ?? '',
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: () => Date.now() + 180_000,
  });

  const site = siteConfigFromEnv();
  const graph = createGraphClient(graphConfigFromEnv());
  const store = createSharePointStore(graph, await resolveSiteId(graph, site));
  const planner = cachedStore(store);

  const scan = await readAgendaScan(monday, {
    boardId,
    dateColumnId: AGENDA_2026_COLUMNS.datum,
    trainerColumnIds: trainerRelationIds(AGENDA_2026_COLUMNS),
  });
  const ids = [...scan.dateByItemId]
    .filter(([, datum]) => datum !== null && datum >= vanaf)
    .sort((a, b) => (a[1] ?? '').localeCompare(b[1] ?? ''))
    .map(([id]) => id);

  const alles: Kandidaat[] = [];
  for (let i = 0; i < ids.length; i += GELIJKTIJDIG) {
    const groep = ids.slice(i, i + GELIJKTIJDIG);
    alles.push(
      ...(
        await Promise.all(
          groep.map(async (itemId): Promise<Kandidaat | null> => {
            let training;
            try {
              training = await readBriefingTraining(monday, itemId, { boardId });
            } catch {
              return null;
            }
            const voorstel = prefillTrainingActor(
              training.acteuraantal,
              countLinkedActors(training)
            );
            const view = buildTabView(training, {
              checklist: { ...EMPTY_CHECKLIST, trainingActor: voorstel },
              actorItemIds: [],
              actorAnswered: true,
            });
            /**
             * Dezelfde planner als de knop, niet een nagebouwde.
             *
             * `planBriefings` schrijft niets — het zoekt de map op en vergelijkt de geplande
             * namen met wat er ligt — dus `folderExists` en `conflicts` komen hier uit exact
             * dezelfde code als straks in productie.
             */
            const uit = await planBriefings(planner, site, {
              label: training.label,
              klant: training.opdrachtgever,
              jaar: yearOfDate(training.datum),
              filenames: plannedFilenames(training, view.checklist, view.actorItemIds),
            });
            const pad = uit.kind === 'ok' ? uit.plan.folderPath : null;
            const bestaat = uit.kind === 'ok' && uit.plan.folderExists;
            return {
              itemId,
              naam: training.naam,
              label: training.label,
              klant: training.opdrachtgever,
              datum: training.datum,
              kanGenereren: view.kanGenereren,
              blokkeert: view.issues.filter((i) => i.blokkeert).map((i) => i.kind),
              documenten: view.documenten.length,
              rollen: view.documenten.map((d) => d.role),
              legeVelden: training.missing.length,
              mapPad: pad,
              mapBestaat: bestaat,
              conflicts: uit.kind === 'ok' ? uit.plan.conflicts : [],
              related: uit.kind === 'ok' ? uit.plan.related : [],
            };
          })
        )
      ).filter((k): k is Kandidaat => k !== null)
    );
    process.stderr.write(`\r  ${alles.length}/${ids.length}`);
  }
  process.stderr.write('\n\n');

  const klaar = alles.filter((k) => k.kanGenereren && k.mapPad !== null);
  console.log(`${alles.length} trainingen gelezen, ${klaar.length} kunnen genereren met een pad\n`);

  const toon = (titel: string, rijen: readonly Kandidaat[], hoeveel = 5): void => {
    console.log(`\n### ${titel}`);
    if (rijen.length === 0) {
      console.log('  (geen)');
      return;
    }
    for (const k of rijen.slice(0, hoeveel)) {
      console.log(`  ${k.itemId}  ${k.datum}  ${k.label.padEnd(4)} ${k.naam.slice(0, 44)}`);
      console.log(
        `      klant=${k.klant.slice(0, 34)} | docs=${k.documenten} (${k.rollen.join('+')}) | lege velden=${k.legeVelden}`
      );
      console.log(
        `      map=${k.mapPad}${k.mapBestaat ? '' : '  [WORDT AANGEMAAKT]'}${k.conflicts.length > 0 ? `  [${k.conflicts.length} BOTSING]` : ''}${k.related.length > 0 ? `  [${k.related.length} eerdere briefing(en)]` : ''}`
      );
    }
    console.log(`  — ${rijen.length} beschikbaar`);
  };

  const opSchoon = (a: Kandidaat, b: Kandidaat): number =>
    a.legeVelden - b.legeVelden || (a.datum ?? '').localeCompare(b.datum ?? '');

  toon(
    'A. Simpelste eerste klik — map bestaat, geen botsing, één document',
    klaar
      .filter((k) => k.mapBestaat && k.conflicts.length === 0 && k.documenten === 1)
      .sort(opSchoon)
  );

  toon(
    'B. Map wordt aangemaakt — test createFolder',
    klaar.filter((k) => !k.mapBestaat && k.documenten === 1).sort(opSchoon)
  );

  toon(
    'C. Een geplande naam ligt er al — test de bevestigingsstap',
    klaar.filter((k) => k.conflicts.length > 0).sort(opSchoon)
  );

  toon(
    'D. Meerdere ontvangers — test meerdere documenten in één run',
    klaar
      .filter((k) => k.documenten > 1)
      .sort((a, b) => b.documenten - a.documenten || opSchoon(a, b))
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
