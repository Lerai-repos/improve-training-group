/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { agendaBoardId, MONDAY_API_VERSION, triggerGroupIds } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { formatAccountmanager, formatContact } from '@lib/briefing/columns';
import { formatDeadline, materialsDeadline } from '@lib/briefing/deadline';
import { readBriefingTraining } from '@lib/briefing/read';

/**
 * Alleen-lezen: laat zien wat de briefing van één training zou maken.
 *
 * Schrijft niets, naar Monday noch naar SharePoint. Bedoeld om per training te
 * controleren of de gegevens kloppen vóórdat er een document uit komt.
 *
 *   pnpm briefing:read <itemId>
 *   pnpm briefing:read            # pakt de eerste training uit Herplannen / Inplannen
 */

const EXIT_FAILURE = 1;

/**
 * De eerste training uit een van de ingestelde triggergroepen.
 *
 * Ongefilterd het eerste item van het bord pakken leverde een willekeurige historische
 * training op, terwijl de hulptekst "Herplannen / Inplannen" belooft. Dan controleer je
 * iets anders dan je denkt.
 */
async function firstPlannableItem(client: ReturnType<typeof createMondayGraphQLClient>) {
  const groups = triggerGroupIds();
  if (groups.length === 0) {
    return null;
  }
  const data = await client.query<{
    boards: Array<{ groups: Array<{ id: string; items_page: { items: Array<{ id: string; name: string }> } }> }>;
  }>(
    `query ($b: [ID!], $g: [String!]) {
       boards(ids: $b) {
         groups(ids: $g) { id items_page(limit: 1) { items { id name } } }
       }
     }`,
    { b: [agendaBoardId()], g: [...groups] }
  );
  for (const group of data.boards?.[0]?.groups ?? []) {
    const item = group.items_page?.items?.[0];
    if (item !== undefined) {
      return item;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });

  let itemId = process.argv[2];
  if (!itemId) {
    const first = await firstPlannableItem(client);
    if (first === null) {
      throw new Error(
        `Geen training gevonden in de triggergroepen (${triggerGroupIds().join(', ') || 'geen ingesteld'}). ` +
          'Geef anders een item-id mee: pnpm briefing:read <itemId>'
      );
    }
    itemId = first.id;
    console.log(`Geen id opgegeven, eerste training uit de triggergroepen: ${first.name} (${itemId})\n`);
  }

  const t = await readBriefingTraining(client, itemId);
  const deadline = formatDeadline(materialsDeadline({ datum: t.datum, tijden: t.tijden }));

  const rows: Array<[string, string]> = [
    ['Opdrachtgever', t.opdrachtgever],
    ['Training', t.themas.join(', ')],
    ['Klanttitel', t.klanttitel],
    ['Duur', t.duur],
    ['Datum & tijd', [t.datum, t.tijden].filter(Boolean).join('; ')],
    ['Groepsgrootte', t.groepsgrootte],
    ['Trainingslocatie', t.locatie],
    ['Voertaal', t.voertaal],
    ['Materialen uiterlijk op', deadline],
    ['Accountmanager', t.accountmanager ? formatAccountmanager(t.accountmanager.naam, t.accountmanager.mobiel) : ''],
    ['Contactpersoon', t.contactpersoon ? formatContact(t.contactpersoon.naam, t.contactpersoon.telefoon) : ''],
    ['Klantcontactmoment', t.klantcontactmoment],
    ['Evaluatie deelnemers', t.evaluatie],
    ['IE-code', t.ieCode],
  ];

  console.log(`${t.naam}   [label ${t.label || '?'} · Brie: ${t.brie || 'leeg'}]\n`);
  for (const [label, value] of rows) {
    console.log(`  ${label.padEnd(24)} ${value || '—'}`);
  }
  console.log(`\n  Trainers                 ${t.trainers.map((x) => `${x.naam}${x.telefoon ? ` (${x.telefoon})` : ''}`).join(', ') || '—'}`);
  console.log(`  Acteuraantal             ${t.acteuraantal ?? '(leeg — niet hetzelfde als 0)'}`);
  console.log(`  Opportunity              ${t.opportunityItemId ?? '—'}`);

  if (t.missing.length === 0) {
    console.log('\n✓ Niets ontbreekt; deze training is klaar om te genereren.');
  } else {
    console.log(`\n${t.missing.length} veld(en) leeg → Brie zou op "Begonnen, niet klaar" komen:`);
    for (const m of t.missing) {
      console.log(`   - ${m.label} (${m.column})`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(EXIT_FAILURE);
});
