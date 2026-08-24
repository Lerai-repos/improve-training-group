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
  resolveRecipients,
  sessionFacts,
} from '@lib/briefing/compose';
import { readHistorie } from '@lib/briefing/historie';
import { readBriefingTraining } from '@lib/briefing/read';
import { readExtraInfo } from '@lib/briefing/updates';
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
 * Checklistvlaggen: --eigen-groep --zelfde-groep --cyclus --huiswerk --voorbereidend --challenge
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
  const ontvangers = resolveRecipients(training, checklist, overrides);
  if (ontvangers.kind === 'ambiguous') {
    const namen = ontvangers.candidates.map((t) => `${t.naam} (${t.itemId})`).join(', ');
    throw new Error(
      `Acteuraantal belooft ${ontvangers.actorsUnaccounted} acteur(s) die niet in de groep ` +
        `Acteurs staan, dus van deze gekoppelde personen is de rol onbekend: ${namen}.\n` +
        '  Wijs de acteur(s) aan met --acteur-is <itemId>, of zet de acteurvraag op ' +
        '--geen-acteur als er geen acteur meewerkt.'
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
  const data = composeBriefing(training, checklist, {
    historie,
    extraInfo: extraInfo.lines,
    mondayChallenge: argv.includes('--challenge'),
    roles: sessionFacts(training, checklist, overrides),
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

  console.log(`\n  Blokken                  ${data.blokken.length === 0 ? '—' : ''}`);
  for (const block of data.blokken) {
    console.log(`    ${block.titel} (${block.regels.length} alinea's)`);
  }

  if (training.missing.length > 0) {
    console.log(`\n  ${training.missing.length} verplicht veld(en) leeg → Brie zou op "${BRIE.onvolledig}" komen:`);
    for (const field of training.missing) {
      console.log(`    - ${field.label} (${field.column})`);
    }
  }

  const open = openIssues(data);
  if (open.length > 0) {
    console.log(`\n  ${open.length} bron(nen) nog niet aangesloten; die staan zichtbaar in het document:`);
    for (const line of open) {
      console.log(`    ${line}`);
    }
  }

  const buffer = await renderBriefing(training.label, data);
  const filename = briefingFilename({
    opdrachtgever: data.opdrachtgever,
    thema: data.thema,
    isoDatum: training.datum,
    // Acteurs horen niet in de bestandsnaam: die noemt de trainer(s) die hem ontvangen.
    trainers: ontvangers.trainers.map((t) => t.naam),
  });
  const outputDir = readOutputDir(argv);
  await mkdir(outputDir, { recursive: true });
  const target = path.join(outputDir, filename);
  await writeFile(target, buffer);

  console.log(`\n  Geschreven: ${target}\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
