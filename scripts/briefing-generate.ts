/* eslint-disable no-console */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { agendaBoardId, MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import {
  prefillTrainingActor,
  type BriefingChecklist,
} from '@lib/briefing/blocks';
import {
  composeBriefing,
  countLinkedActors,
  openIssues,
  sessionFacts,
} from '@lib/briefing/compose';
import { resolveRecipientRoles } from '@lib/briefing/recipients';
import { readHistorie } from '@lib/briefing/historie';
import { readBriefingTraining } from '@lib/briefing/read';
import { readExtraInfo } from '@lib/briefing/updates';
import { readTrainerAddresses, resolveBriefingTravel } from '@lib/briefing/reis';
import type { TravelInput } from '@lib/briefing/format';
import { createAddressFormatter } from '@lib/recommend/address';
import { createOpenRouterCompletion } from '@lib/recommend/completion';
import { createRoutesProvider, createGoogleRoutesTransport } from '@lib/recommend/travel';
import {
  createTravelCache,
  createKvTravelCacheStore,
  createMemoryTravelCacheStore,
} from '@lib/recommend/travel-cache';
import { createUpstashKvStore, createRedisClient } from '@lib/recommend/kv';
import { loadSettingsOnce } from '@lib/settings/load';
import { briefingFilename, renderBriefing } from '@lib/briefing/render';
import { BRIE } from '@lib/briefing/types';

/**
 * De hele keten in één keer: Monday lezen, samenstellen, sjabloon invullen, bestand wegschrijven.
 *
 * Schrijft **niets** terug naar Monday en niets naar SharePoint. Het enige resultaat is een
 * `.docx` op schijf, zodat de gegevens naast de voorbeeldbriefing gelegd kunnen worden
 * vóórdat er iets naar een trainer gaat.
 *
 *   pnpm briefing:generate <itemId>
 *   pnpm briefing:generate <itemId> --cyclus --huiswerk
 *   pnpm briefing:generate <itemId> --uit ./ergens-anders
 *   pnpm briefing:generate <itemId> --concept ./eigen-bullets.txt
 *
 * Checklistvlaggen: --eigen-groep --zelfde-groep --cyclus --huiswerk --voorbereidend
 * --acteur-is <itemId> wijst een gekoppelde persoon aan als acteur (mag meerdere keren).
 * De acteurvraag is verplicht: geef --acteur of --geen-acteur. Monday doet een voorstel,
 * maar beide signalen zijn onvolledig, dus het antwoord komt van de adviseur.
 */

const EXIT_FAILURE = 1;
const DEFAULT_OUTPUT_DIR = 'briefing-demo';

/**
 * De checklist uit de vlaggen. De acteurvraag moet **expliciet** beantwoord worden.
 *
 * Het voorstel uit Monday stilzwijgend als antwoord gebruiken zou precies het geval missen
 * waar het om gaat: allebei de signalen zijn onvolledig, dus als ze samen een acteur missen
 * verdwijnt het acteurblok zonder dat iemand het merkt. `06-briefing.md` stelt dit dan ook
 * als checklistvraag, niet als afleiding. Dit is de opdrachtregelversie van dat vinkje; in
 * de app wordt het een radioknop met dezelfde voorinvulling.
 */
/**
 * `--concept <bestand>`: de concept-inhoud die de adviseur zelf heeft geschreven.
 *
 * In de app-tab wordt dit een tekstvak dat is voorgevuld met het skelet van het thema. Dat
 * tabblad bestaat nog niet, en tot die tijd is dit de enige manier om de afwijkende versie
 * te beproeven — zonder dit gedraagt de keten zich als een doorgeefluik en is precies het
 * stuk dat we wilden bouwen niet te zien.
 *
 * Een bestand en geen argument op de opdrachtregel: het zijn twaalf regels tekst met
 * accenten en aanhalingstekens erin.
 */
function readConceptOverride(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--concept');
  if (at === -1) {
    return undefined;
  }
  const path = argv[at + 1];
  if (path === undefined || path.startsWith('--')) {
    throw new Error('--concept verwacht een bestandsnaam: --concept ./mijn-bullets.txt');
  }
  if (!existsSync(path)) {
    throw new Error(`--concept: bestand niet gevonden: ${path}`);
  }
  const text = readFileSync(path, 'utf-8');
  if (text.trim() === '') {
    throw new Error(
      `--concept: ${path} is leeg. Laat de vlag weg om het skelet van het thema te gebruiken; ` +
        'een leeg bestand zou stilzwijgend hetzelfde doen en dat is niet te zien in het document.'
    );
  }
  return text;
}

/**
 * `--historie-max <n>`: hoeveel rijen de tabel hoogstens krijgt.
 *
 * Een vlag en geen constante omdat **nog niet aan Dirkje gevraagd is** hoe lang de tabel mag
 * worden. CNV heeft 32 sessies, DAS 28. Zonder vlag komt alles erin, zodat je meteen ziet
 * hoe erg dat is.
 */
function readHistorieLimit(argv: readonly string[]): number | undefined {
  const at = argv.indexOf('--historie-max');
  if (at === -1) {
    return undefined;
  }
  const raw = argv[at + 1];
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 1) {
    throw new Error('--historie-max verwacht een positief geheel getal: --historie-max 10');
  }
  return value;
}

function readChecklist(argv: readonly string[], voorstel: boolean): BriefingChecklist {
  const ja = argv.includes('--acteur');
  const nee = argv.includes('--geen-acteur');
  if (ja && nee) {
    throw new Error('Kies --acteur of --geen-acteur, niet allebei.');
  }
  if (!ja && !nee) {
    throw new Error(
      'Beantwoord de acteurvraag met --acteur of --geen-acteur.\n' +
        `  Monday stelt voor: ${voorstel ? '--acteur' : '--geen-acteur'} ` +
        `(Acteuraantal en de groep Acteurs; allebei onvolledig, dus controleer het even).`
    );
  }
  return {
    ownGroup: argv.includes('--eigen-groep'),
    sameGroup: argv.includes('--zelfde-groep'),
    trainingCycle: argv.includes('--cyclus'),
    homework: argv.includes('--huiswerk'),
    preparatoryAssignment: argv.includes('--voorbereidend'),
    trainingActor: ja,
    conceptInhoud: readConceptOverride(argv),
  };
}

/**
 * De item-ids die de adviseur zelf als acteur aanwijst: `--acteur-is 500 --acteur-is 501`.
 *
 * Nodig omdat de groep `Acteurs` op het trainersbord gemeten incompleet is. Zonder een manier
 * om het handmatig te zeggen zou een training met een niet-ingedeelde acteur nooit te
 * genereren zijn.
 */
function readActorIds(argv: readonly string[]): string[] {
  const ids: string[] = [];
  argv.forEach((arg, i) => {
    if (arg === '--acteur-is') {
      const waarde = argv[i + 1];
      if (waarde === undefined || waarde.startsWith('--')) {
        throw new Error('--acteur-is verwacht een item-id als volgende argument');
      }
      ids.push(waarde);
    }
  });
  return ids;
}

function readOutputDir(argv: readonly string[]): string {
  const index = argv.indexOf('--uit');
  if (index === -1) {
    return DEFAULT_OUTPUT_DIR;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--uit verwacht een map als volgende argument');
  }
  return value;
}

/**
 * Km en reistijd per trainer, of een lege kaart als het niet kan.
 *
 * Leeg is hier geen storing maar het bestaande gedrag: dan houdt de gegevenstabel zijn
 * zichtbare `«nog niet aangesloten»`-regel. Zo blijft dit script bruikbaar op een machine
 * zonder Google-sleutel of KV, precies zoals vóór deze stap.
 *
 * De acteurs zitten er bewust bij: die rijden net zo goed naar de locatie, en zij krijgen
 * hun eigen document met hun eigen km's.
 */
async function resolveReis(
  client: ReturnType<typeof createMondayGraphQLClient>,
  training: Awaited<ReturnType<typeof readBriefingTraining>>,
  itemIds: readonly string[]
): Promise<ReadonlyMap<string, TravelInput>> {
  const nodig = ['OPENROUTER_API_KEY', 'GOOGLE_MAPS_API_KEY'];
  const missend = nodig.filter((naam) => (process.env[naam] ?? '') === '');
  if (missend.length > 0) {
    console.log(`  Km/reistijd overgeslagen: ${missend.join(', ')} ontbreekt in .env.local.`);
    return new Map();
  }

  /**
   * De gedeelde routecache, of anders een cache in het geheugen.
   *
   * Niet zelf op namen van omgevingsvariabelen toetsen: `createRedisClient` accepteert zowel
   * `UPSTASH_REDIS_REST_*` (wat `.env.example` voorschrijft) als Vercels alias
   * `KV_REST_API_*`, en alleen op die tweede kijken koos hier stilletjes de cache in het
   * geheugen. Gemeten: lokaal staat de UPSTASH-variant wél en de KV-variant niet, dus elke
   * briefing betaalde opnieuw voor routes die de aanbevelingsengine al had opgehaald.
   *
   * Hem laten wérpen is dus de toets zelf, en die kan niet uit de pas gaan lopen met
   * `kv.ts`. Zonder cache blijft het script bruikbaar — dezelfde uitkomst, alleen betaalt
   * die run zijn eigen Google-aanroepen.
   */
  let store;
  try {
    store = createKvTravelCacheStore(createUpstashKvStore(createRedisClient()));
  } catch {
    store = createMemoryTravelCacheStore();
    console.log('  Let op: geen Redis-cache, dus routes gelden alleen binnen deze run.');
  }

  const settings = await loadSettingsOnce(client);
  const adressen = await readTrainerAddresses(client, itemIds);
  const travel = await resolveBriefingTravel(
    {
      formatter: createAddressFormatter(createOpenRouterCompletion(process.env.OPENROUTER_API_KEY ?? '')),
      cache: createTravelCache(store),
      provider: createRoutesProvider(
        createGoogleRoutesTransport(process.env.GOOGLE_MAPS_API_KEY ?? '')
      ),
      hqAddress: settings.app.hqAddress,
      thresholdMinutes: settings.app.travelTimeThresholdMinutes,
    },
    {
      locatie: training.locatie,
      trainers: itemIds.map((id) => ({ externalItemId: id, adres: adressen.get(id) ?? null })),
    }
  );
  // Eén regel als iedereen om dezelfde reden geen km krijgt; dat is meestal de locatie,
  // en dan is het één probleem en geen acht.
  const redenen = new Set(travel.zonder.map((z) => z.reden));
  if (travel.zonder.length > 0 && redenen.size === 1) {
    console.log(`  LET OP: geen km voor ${travel.zonder.length} trainer(s) — ${[...redenen][0]}`);
  } else {
    for (const ontbreekt of travel.zonder) {
      console.log(`  LET OP: geen km voor trainer ${ontbreekt.itemId} (${ontbreekt.reden}).`);
    }
  }
  return travel.perTrainer;
}

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const argv = process.argv.slice(2);
  const itemId = argv.find((a) => !a.startsWith('--') && /^\d+$/.test(a));
  if (itemId === undefined) {
    throw new Error('Geef een item-id op: pnpm briefing:generate <itemId>');
  }
  /**
   * `--challenge` weigeren in plaats van negeren.
   *
   * De vlag zette de harde Monday Challenges-regel onder de achtergrondinformatie. Die regel
   * is uit het sjabloon verdwenen — ITG's eigen brondocument zet de aansporing bovenaan, en
   * onvoorwaardelijk — dus er valt niets meer aan te zetten. De parser kijkt alleen naar
   * vlaggen die hij kent, dus zonder deze controle levert de oude aanroep hetzelfde document
   * op zonder één woord uitleg, en dan zoek je het verschil in het document in plaats van hier.
   */
  if (argv.includes('--challenge')) {
    throw new Error(
      '--challenge bestaat niet meer: de Monday Challenges-regel staat nu altijd in de briefing, ' +
        'boven de gegevenstabel. Laat de vlag weg.'
    );
  }

  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const training = await readBriefingTraining(client, itemId, { boardId: agendaBoardId() });

  console.log(`\n${training.naam}   [label ${training.label} · Brie: ${training.brie}]\n`);

  /**
   * "Interne trainer" betekent: deze training krijgt geen briefing. Dat hier controleren en
   * niet alleen in de generator, zodat een handmatige run dezelfde regel volgt als de
   * automatische.
   */
  if (training.brie === BRIE.interneTrainer) {
    console.log(`Brie staat op "${BRIE.interneTrainer}"; er wordt geen briefing gemaakt.`);
    return;
  }

  const voorstel = prefillTrainingActor(training.acteuraantal, countLinkedActors(training));
  const checklist = readChecklist(argv, voorstel);
  if (checklist.trainingActor !== voorstel) {
    console.log(
      `  LET OP: acteurvraag staat op ${checklist.trainingActor ? 'ja' : 'nee'}, ` +
        `Monday stelde ${voorstel ? 'ja' : 'nee'} voor.\n`
    );
  }
  /**
   * Wie de briefing ontvangt moet vaststaan vóórdat er iets geschreven wordt: de namen komen
   * in de bestandsnaam en bepalen straks bij wie het document terechtkomt. Een naam die
   * misschien van de acteur is, is geen kleine schoonheidsfout maar een verkeerde levering.
   */
  const actorItemIds = readActorIds(argv);
  if (!checklist.trainingActor && actorItemIds.length > 0) {
    throw new Error(
      '--geen-acteur en --acteur-is spreken elkaar tegen: je zegt dat er geen acteur meewerkt ' +
        'en wijst er tegelijk een aan.'
    );
  }
  const overrides = { actorItemIds };
  const ontvangers = resolveRecipientRoles(training, checklist, overrides);
  if (ontvangers.kind === 'ambiguous') {
    const namen = ontvangers.candidates.map((t) => `${t.naam} (${t.itemId})`).join(', ');
    throw new Error(
      `Acteuraantal belooft ${ontvangers.actorsUnaccounted} acteur(s) die niet in de groep ` +
        `Acteurs staan, dus van deze gekoppelde personen is de rol onbekend: ${namen}.\n` +
        '  Wijs de acteur(s) aan met --acteur-is <itemId>, of zet de acteurvraag op ' +
        '--geen-acteur als er geen acteur meewerkt.'
    );
  }
  /**
   * Twee mensen in de leadkolom: de legacy-toestand van vóór de kolomsplitsing. Er valt niet
   * te zeggen wie leidt, en het lead- en het co-blok beweren het tegenovergestelde over wie
   * het klantcontact doet. Dus geen document met een gok erin.
   */
  if (ontvangers.kind === 'no_single_lead') {
    if (ontvangers.leadCandidates.length === 0) {
      throw new Error(
        'Er is geen leadtrainer: iedereen staat in de kolom Co-trainer(s), of de enige ' +
          'persoon in de leadkolom is als acteur aangemerkt.\n' +
          '  Elk document zou dan verwijzen naar een leadtrainer die niet bestaat — de ' +
          'co-trainer en de acteur krijgen "n.v.t., door lead trainer" bij ' +
          'Klantcontactmoment.\n' +
          '  Zet één trainer in de kolom Trainers contactgegevens en draai opnieuw.'
      );
    }
    const namen = ontvangers.leadCandidates.map((t) => `${t.naam} (${t.itemId})`).join(', ');
    throw new Error(
      `Er staan ${ontvangers.leadCandidates.length} mensen in de leadkolom, dus wie de ` +
        `leadtrainer is staat nergens: ${namen}.\n` +
        '  Zet de co-trainer(s) in de kolom Co-trainer(s) op het agendabord en draai opnieuw.'
    );
  }

  const extraInfo = await readExtraInfo(client, [training.itemId, training.opportunityItemId]);
  /**
   * De historie hoort bij het blok `Vaste klant`, en dat blok komt er alleen als de
   * checklist erom vraagt. Toch wordt hij altijd gelezen: de adviseur moet in de app-tab
   * kunnen zien dát er eerdere sessies zijn voordat hij het vinkje zet, anders moet hij dat
   * zelf in de agenda opzoeken — precies het werk dat dit blok hoort weg te nemen.
   */
  const historie = await readHistorie(client, {
    bedrijf: training.opdrachtgever,
    excludeItemId: training.itemId,
    limit: readHistorieLimit(argv),
  });
  if (historie.length > 0) {
    console.log(`  Historie: ${historie.length} eerdere/komende sessie(s) bij ${training.opdrachtgever}`);
  }
  const reis = await resolveReis(
    client,
    training,
    ontvangers.recipients.map((r) => r.trainer.itemId)
  );
  const gedeeld = {
    historie,
    extraInfo: extraInfo.lines,
    roles: sessionFacts(training, checklist, overrides),
  };
  /**
   * De gegevenstabel is voor iedereen bijna gelijk, dus die wordt één keer getoond — met de
   * eerste ontvanger als voorbeeld. Wat per persoon verschilt (Klantcontactmoment, straks de
   * km's) staat per document eronder.
   */
  const eerste = ontvangers.recipients[0];
  if (eerste === undefined) {
    throw new Error('Geen ontvangers: er hangt niemand aan deze training.');
  }
  const data = composeBriefing(training, checklist, {
    ...gedeeld,
    recipient: eerste,
    reis: reis.get(eerste.trainer.itemId),
  });

  console.log('  Gegevenstabel');
  const rows: Array<[string, string]> = [
    ['Opdrachtgever', data.opdrachtgever],
    ['Training', data.thema],
    ['Klanttitel', data.klanttitel],
    ['Duur', data.duur],
    ['Datum & tijd', data.datumTijd],
    ['Groepsgrootte', data.groepsgrootte],
    ['Trainingslocatie', data.locatie],
    ['Voertaal', data.voertaal],
    ['Materialen uiterlijk op', data.materialenDeadline],
    ['Accountmanager', data.accountmanager],
    ['Km. / Reistijd', data.reis],
    ['Contactpersoon', data.contactpersoon],
    ['Klantcontactmoment', data.klantcontactmoment],
    ['Evaluatie deelnemers', data.evaluatie],
    ['IE-code', data.iecode],
    ['Trainingscode MC', data.trainingscodeMc],
  ];
  for (const [label, value] of rows) {
    console.log(`    ${label.padEnd(24)} ${value === '' ? '—' : value}`);
  }

  console.log(`\n  Extra informatie trainer ${data.extraInfo.length === 0 ? '— (geen gemarkeerde updates)' : ''}`);
  for (const line of data.extraInfo) {
    console.log(`    ${line.length > 96 ? `${line.slice(0, 96)}…` : line}`);
  }
  if (extraInfo.truncated) {
    console.log('    LET OP: Monday heeft de updateslijst afgekapt; er kan tekst missen.');
  }

  if (training.missing.length > 0) {
    console.log(`\n  ${training.missing.length} verplicht veld(en) leeg → Brie zou op "${BRIE.onvolledig}" komen:`);
    for (const field of training.missing) {
      console.log(`    - ${field.label} (${field.column})`);
    }
  }

  /**
   * Eén document per ontvanger. Dirkje: *"De briefing gaat naar mensen persoonlijk (staan ook
   * hun eigen km's bijv in). Dus ze krijgen de tekst idd obv hun rol."*
   */
  const outputDir = readOutputDir(argv);
  await mkdir(outputDir, { recursive: true });
  const rol = { lead: 'Leadtrainer', co: 'Co-trainer', acteur: 'Trainingsacteur' } as const;

  console.log(`\n  ${ontvangers.recipients.length} ontvanger(s)`);
  for (const ontvanger of ontvangers.recipients) {
    const eigen = composeBriefing(training, checklist, {
      ...gedeeld,
      recipient: ontvanger,
      reis: reis.get(ontvanger.trainer.itemId),
    });

    console.log(`\n  ── ${ontvanger.trainer.naam} — ${rol[ontvanger.role]}`);
    console.log(`     Klantcontactmoment  ${eigen.klantcontactmoment === '' ? '—' : eigen.klantcontactmoment}`);
    console.log(`     Km. / Reistijd      ${eigen.reis}`);
    // Rolblokken én de rest: ze staan in het document op verschillende plaatsen (boven en
    // onder Concept inhoud), maar hier gaat het om wát erin staat.
    const alle = [...eigen.rolblokken, ...eigen.blokken];
    console.log(`     Blokken             ${alle.length === 0 ? '—' : ''}`);
    for (const block of alle) {
      const bullets = block.regels.filter((r) => r.bullet).length;
      console.log(
        `       ${block.titel} (${block.regels.length} alinea's, waarvan ${bullets} opsomming)`
      );
    }

    const open = openIssues(eigen);
    if (open.length > 0) {
      console.log(`     ${open.length} bron(nen) nog niet aangesloten; zichtbaar in het document:`);
      for (const line of open) {
        console.log(`       ${line}`);
      }
    }

    const buffer = await renderBriefing(training.label, eigen);
    const filename = briefingFilename({
      opdrachtgever: eigen.opdrachtgever,
      thema: eigen.thema,
      isoDatum: training.datum,
      // Eén naam: dit exemplaar is van deze persoon, ook als het een acteur is.
      trainers: [ontvanger.trainer.naam],
    });
    const target = path.join(outputDir, filename);
    await writeFile(target, buffer);
    console.log(`     Geschreven: ${target}`);
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
