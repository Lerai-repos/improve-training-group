/**
 * Read-only probe van ITG's SharePoint. Schrijft NIETS.
 *
 * Beantwoordt in volgorde: krijgen we een token, mogen we de site opzoeken, staat de
 * documentbibliotheek waar we denken, en zien de labelmappen eruit zoals `paths.ts`
 * verwacht. Die laatste is het echte risico — de mappenstructuur verschilt per label.
 */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { siteConfigFromEnv } from '@lib/sharepoint/config';
import { createGraphClient, graphConfigFromEnv } from '@lib/sharepoint/graph';
import { matchKlantenFolder, matchLabelFolder } from '@lib/sharepoint/paths';
import { createSharePointStore, resolveSiteId } from '@lib/sharepoint/store';

const LABELS = ['IT', 'WJ', 'JE', 'FV', 'SST', 'TT', 'CC', 'CP', 'FT'] as const;

async function main(): Promise<void> {
  for (const naam of ['MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET']) {
    console.log(`${process.env[naam] ? 'OK ' : 'MIST'}  ${naam}`);
  }

  const site = siteConfigFromEnv();
  console.log(`\nSite: ${site.host}${site.path}  wortel="${site.root}"`);

  const graph = createGraphClient(graphConfigFromEnv());

  let siteId: string;
  try {
    siteId = await resolveSiteId(graph, site);
    console.log(`site-id opgehaald: ${siteId.slice(0, 60)}…`);
  } catch (error) {
    console.log(`\nSITE-LOOKUP MISLUKT: ${error instanceof Error ? error.message : String(error)}`);
    console.log(
      'Dit is de open vraag: Files.ReadWrite.All dekt /sites/{host}:{pad} mogelijk niet.'
    );
    return;
  }

  const store = createSharePointStore(graph, siteId);

  const wortel = await store.children(site.root);
  console.log(`\n"${site.root}" bevat ${wortel.length} mappen:`);
  for (const naam of wortel) {
    console.log(`  ${naam}`);
  }

  console.log('\nLabelmappen volgens matchLabelFolder:');
  for (const label of LABELS) {
    const treffer = matchLabelFolder(wortel, label);
    console.log(`  ${label.padEnd(4)} ${treffer.kind === 'found' ? treffer.name : treffer.kind}`);
  }

  for (const label of LABELS) {
    const treffer = matchLabelFolder(wortel, label);
    if (treffer.kind !== 'found') {
      continue;
    }
    const pad = `${site.root}/${treffer.name}`;
    const kinderen = await store.children(pad);
    const klanten = matchKlantenFolder(kinderen);
    console.log(`\n${label} — "${treffer.name}" (${kinderen.length} mappen)`);
    console.log(`  Klantenmap: ${klanten.kind === 'found' ? klanten.name : klanten.kind}`);
    console.log(`  inhoud: ${kinderen.slice(0, 12).join(' | ')}`);
    if (klanten.kind === 'found') {
      const jaren = await store.children(`${pad}/${klanten.name}`);
      console.log(`  jaren: ${jaren.slice(0, 12).join(' | ')}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
