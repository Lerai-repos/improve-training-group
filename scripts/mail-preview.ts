/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { buildMailFacts, composeMails, mailRecipients } from '@lib/mail';
import { buildReportRunDeps } from '@lib/report/deps';
import { runReport } from '@lib/report/run';
import { readTrainerEmails } from '@lib/report/trainer-emails';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';

/**
 * De twee mails van één training op het scherm, zonder ze te versturen.
 *
 *   pnpm mail:preview <agenda-item-id>
 *
 * Hiermee zijn de teksten na te lezen voordat ze bij ITG in de postbus liggen, en hiermee is
 * te controleren of de gele velden uit het V2-document echt gevuld worden: de datum, het
 * thema, de trainersnaam, het aantal respondenten, het cijfer, het percentage, de IE-code en
 * de evaluatieformulier-URL van het label.
 *
 * **Er wordt geen PDF gerenderd.** De renderer is vervangen door een dummy: het rapport zelf
 * is via `pnpm report:generate` te bekijken, en Chromium starten om een bijlage te maken die
 * toch niet getoond wordt is verspilling. Alles daarvóór — de huisstijl ophalen, de reacties
 * toekennen, het gemiddelde en het percentage berekenen — gebeurt wél echt.
 */

const EXIT_FAILURE = 1;
const DUMMY_PDF = new Uint8Array([1]);

async function main(): Promise<void> {
  const itemId = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (itemId === undefined) {
    throw new Error('Geef een agenda-item-id mee: pnpm mail:preview <id>');
  }

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('MONDAY_API_TOKEN is not configured');
  }
  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });

  const deps = { ...buildReportRunDeps(), renderer: { render: async () => DUMMY_PDF } };
  const outcome = await runReport(itemId, deps);

  if (outcome.kind !== 'ok' && outcome.kind !== 'no_responses') {
    console.log(`\n  ${outcome.kind}: hier gaat geen mail over de deur.\n`);
    return;
  }

  const { training } = outcome;
  const variant = outcome.kind === 'ok' ? 'met' : 'zonder';
  /**
   * De labelcode apart, met een echte controle in plaats van een uitroepteken.
   *
   * `runReport` komt alleen tot `no_responses` nádat het label is opgelost, dus hij ís hier
   * gevuld — maar dat weet het type niet, en een niet-null-bewering is precies het soort
   * belofte dat blijft staan als die volgorde ooit verandert.
   */
  const labelCode = training.labelCode;
  if (labelCode === null) {
    throw new Error('Deze training heeft geen label; er valt geen mail over op te maken.');
  }
  const label = outcome.kind === 'ok' ? outcome.label : await deps.readLabel(labelCode);
  if (label === null) {
    throw new Error('Het label van deze training staat niet op het Labels-bord.');
  }

  const facts = buildMailFacts({
    datum: training.datum,
    klanttitel: training.klanttitel,
    themaNamen: training.themaNamen,
    labelNaam: label.volledigeNaam,
    rapportterm: label.rapportterm,
    evaluatieformulier: label.evaluatieformulier,
    contactPersoon: training.contactPersoon,
    trainerNamen: training.trainerNamen,
    trainerEmails: await readTrainerEmails(client, training.trainerItemIds),
    accountmanager: training.accountmanager,
    ieCode: training.rawIeCode ?? '',
    aantalRespondenten: outcome.kind === 'ok' ? outcome.report.responseCount : 0,
    gemiddelde: outcome.kind === 'ok' ? outcome.report.gemiddeldeBeoordeling : null,
    vervolgPercentage: outcome.kind === 'ok' ? outcome.report.vervolgPercentage : null,
  });

  const recipients = mailRecipients();
  const mails = composeMails({
    variant,
    facts,
    recipients,
    rapport: variant === 'met' ? DUMMY_PDF : undefined,
  });

  for (const composed of mails) {
    console.log(`\n${'#'.repeat(78)}`);
    console.log(`# ${composed.doel.toUpperCase()}  →  ${composed.mail.to.join(', ')}`);
    console.log(`# Onderwerp: ${composed.mail.subject}`);
    console.log(
      `# Bijlage: ${composed.mail.attachment === undefined ? 'geen' : composed.mail.attachment.filename}`
    );
    console.log(`${'#'.repeat(78)}\n`);
    console.log(composed.mail.body);
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
