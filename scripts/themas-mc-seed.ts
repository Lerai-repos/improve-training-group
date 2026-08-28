/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  isProductCode,
  resolveCodes,
  type CodesByName,
  type ThemaKaart,
} from '@lib/briefing/mc-codes';
import { MONDAY_API_VERSION, THEMAS_BOARD } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';

/**
 * De productcodes in de acht MC-kolommen op het Themabord schrijven.
 *
 * Tweede stap na `themas-mc-codes.ts`, dat alleen de kolommen maakt. Botsende cellen blijven
 * met opzet LEEG: waar twee namen een verschillende code voor dezelfde cel aandragen kunnen
 * wij niet kiezen, en een verkeerde code komt zonder enige fout in een klantbriefing terecht.
 *
 *   pnpm exec tsx scripts/themas-mc-seed.ts            (droogloop)
 *   pnpm exec tsx scripts/themas-mc-seed.ts --apply
 */

const XLSX =
  'docs/Improve Training Group/Shared/Briefing bestanden/ITG - Productcodes Monday Challenges.xlsx';

/**
 * Alleen de groep met de échte trainingsthema's.
 *
 * Het bord heeft daarnaast `Aanbestedingen`, en dat is geen productgroep: er staat één item
 * in, dat toevallig `Focus en aandacht` heet — dezelfde naam als een echt thema. Zonder deze
 * grens is "het thema met die naam" meerduidig en blijven twaalf codes onnodig liggen.
 *
 * Gepind, niet afgeleid: "de groep met de meeste items" raadt, en raden op een bord dat ITG
 * zelf beheert is precies hoe een code op het verkeerde item belandt.
 */
const THEMA_GROEP = 'group_mkx718dp';

const KOLOM_VAN_LABEL: Readonly<Record<string, string>> = {
  IT: 'itg_mc_it',
  JE: 'itg_mc_je',
  TT: 'itg_mc_tt',
  SST: 'itg_mc_sst',
  FV: 'itg_mc_fv',
  WJ: 'itg_mc_wj',
  CC: 'itg_mc_cc',
  CP: 'itg_mc_cp',
};

interface BoardItem {
  id: string;
  name: string;
  group: { id: string; title: string };
  column_values: { id: string; text: string | null }[];
}

function leesWerkblad(): CodesByName {
  const json = execFileSync('python3', ['tools/mc-codes/extract.py', XLSX], {
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const rauw = JSON.parse(json) as Record<string, Record<string, string>>;
  return new Map(
    Object.entries(rauw).map(([naam, perLabel]) => [naam, new Map(Object.entries(perLabel))])
  );
}

async function main(): Promise<void> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }
  const apply = process.argv.includes('--apply');

  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const kolomIds = Object.values(KOLOM_VAN_LABEL);
  const data = await read.query<{
    boards: { columns: { id: string }[]; items_page: { items: BoardItem[] } }[];
  }>(
    `query ($b: [ID!], $cols: [String!]) {
       boards(ids: $b) {
         columns { id }
         items_page(limit: 500) {
           items { id name group { id title } column_values(ids: $cols) { id text } }
         }
       }
     }`,
    { b: [THEMAS_BOARD], cols: kolomIds }
  );
  const board = data.boards?.[0];
  if (board === undefined) {
    throw new Error(`Themas-bord ${THEMAS_BOARD} niet gevonden`);
  }
  const aanwezig = new Set(board.columns.map((c) => c.id));
  const missend = kolomIds.filter((id) => !aanwezig.has(id));
  if (missend.length > 0) {
    throw new Error(`Kolommen ontbreken: ${missend.join(', ')}. Draai eerst themas-mc-codes.ts.`);
  }

  const alle = board.items_page.items;
  const items = alle.filter((i) => i.group.id === THEMA_GROEP);
  if (items.length === 0) {
    throw new Error(
      `Groep ${THEMA_GROEP} leverde geen items op. Is de groep hernoemd of verplaatst? ` +
        `Gevonden groepen: ${[...new Set(alle.map((i) => `${i.group.id} (${i.group.title})`))].join(', ')}`
    );
  }
  console.log(
    `  ${items.length} thema's in groep "${items[0].group.title}" van ${alle.length} items op het bord\n`
  );
  /**
   * BEIDE kaarten, en dat is geen detail.
   *
   * De skelettenkaart legt al 41 namen vast ('Omgaan met agressie' → 'Agressie'); die van
   * ons vult alleen aan waar het codebestand anders spelt dan het skelettenbestand. Alleen
   * de onze laden laat 41 thema's stil ongekoppeld, en dan lijkt het alsof ITG nog van alles
   * moet beslissen wat allang beslist is.
   */
  const skeletten = JSON.parse(
    readFileSync('tools/skeletten/thema-map.json', 'utf-8')
  ) as ThemaKaart;
  const eigen = JSON.parse(readFileSync('tools/mc-codes/thema-map.json', 'utf-8')) as ThemaKaart;
  /**
   * Onze kaart heft een openstaande SKELETvraag op, want het zijn twee verschillende vragen.
   *
   * "Welke skelettekst wint op dit thema?" is onbeslist; "waar hoort deze code heen?" is dat
   * niet, zolang de namen verschillende labelkolommen vullen. `Succesvol veranderen` (IT, JE,
   * SST, CC) en `Gewoontes en patronen veranderen` (FV, WJ) passen naast elkaar in de rij
   * `Veranderen`. Zonder deze regel blijven negen codes onnodig liggen op een vraag die voor
   * codes niet bestaat.
   */
  const gemeenschappelijk = { ...skeletten.kaart, ...eigen.kaart };
  const open: Record<string, string> = { ...skeletten.openVraag, ...eigen.openVraag };
  for (const naam of Object.keys(eigen.kaart)) {
    delete open[naam];
  }
  const kaart: ThemaKaart = { kaart: gemeenschappelijk, openVraag: open };
  const uit = resolveCodes(leesWerkblad(), kaart, new Set(items.map((i) => i.name)));

  /**
   * Dubbele itemnamen maken "het" thema meerduidig.
   *
   * De bekende botsing (`Focus en aandacht`) is opgelost door alleen de themagroep te
   * lezen. Deze controle blijft staan voor een duplicaat BINNEN die groep: dan is er geen
   * groep meer om op te scheiden en is overslaan het enige eerlijke antwoord.
   */
  const telling = new Map<string, number>();
  for (const item of items) {
    telling.set(item.name, (telling.get(item.name) ?? 0) + 1);
  }
  const dubbel = new Set([...telling].filter(([, n]) => n > 1).map(([naam]) => naam));

  /**
   * Cellen die LEEG horen te zijn omdat er twee codes voor zijn.
   *
   * Melden is niet genoeg: een botsing kan ontstaan ná een eerdere run. Toen `Verjaag de
   * Calimero in je` nog geen thema had, vulde `Zichtbaarheid en invloed vergroten` de
   * JE-cel onbetwist met JE-69; zodra ITG zei dat die twee hetzelfde thema zijn, werd dat
   * een keuze die niemand had gemaakt — met de gekozen waarde al op het bord. Een botsende
   * cel wordt daarom actief leeggemaakt, niet alleen overgeslagen.
   */
  const geblokkeerd = new Set(uit.botsingen.map((b) => `${b.thema}\u0000${b.label}`));

  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });
  let geschreven = 0;
  let ongewijzigd = 0;
  let overgeslagen = 0;
  let gewist = 0;

  for (const item of items) {
    const gewenst = uit.perThema.get(item.name) ?? new Map<string, string>();
    if (dubbel.has(item.name)) {
      console.log(
        `  OVERGESLAGEN  "${item.name}" komt ${telling.get(item.name)}x voor op het bord`
      );
      overgeslagen += gewenst.size;
      continue;
    }
    /**
     * Opruimen gaat over ÁLLE thema's, ook die zonder gewenste code.
     *
     * `Eilandjes` heeft alleen maar `NOG MAKEN`-waarden, dus na het filteren blijft er niets
     * gewenst over. Zou dat het item overslaan, dan blijft precies de rommel staan die
     * opgeruimd moet worden.
     */
    const huidig = new Map(item.column_values.map((c) => [c.id, (c.text ?? '').trim()]));

    /**
     * Opruimen wat er niet hoort te staan.
     *
     * Een eerdere run schreef `NOG MAKEN` weg, want dat stond in de codekolom van het
     * werkblad. Zo'n waarde stil laten staan is erger dan een lege cel: hij ziet eruit als
     * een code en komt in de gegevenstabel van een klantbriefing terecht.
     */
    for (const [kolom, waarde] of huidig) {
      const label = Object.entries(KOLOM_VAN_LABEL).find(([, id]) => id === kolom)?.[0];
      const botst = label !== undefined && geblokkeerd.has(`${item.name}\u0000${label}`);
      if (waarde !== '' && (botst || !isProductCode(waarde))) {
        console.log(
          `  ${apply ? 'WIS   ' : 'would wissen '} ${item.name.slice(0, 40).padEnd(40)} ${kolom} = ${JSON.stringify(waarde)}`
        );
        if (apply) {
          await write.mutate(
            `mutation ($board: ID!, $item: ID!, $col: String!, $val: String!) {
               change_simple_column_value(board_id: $board, item_id: $item, column_id: $col, value: $val) { id }
             }`,
            { board: THEMAS_BOARD, item: item.id, col: kolom, val: '' },
            { idempotencyKey: `themas-mc-seed:${THEMAS_BOARD}:${item.id}:${kolom}:leeg` }
          );
        }
        gewist += 1;
      }
    }

    for (const [label, code] of gewenst) {
      const kolom = KOLOM_VAN_LABEL[label];
      if (huidig.get(kolom) === code) {
        ongewijzigd += 1;
        continue;
      }
      console.log(
        `  ${apply ? 'APPLY ' : 'would '} ${item.name.slice(0, 40).padEnd(40)} ${label.padEnd(4)} ${code}`
      );
      if (!apply) {
        geschreven += 1;
        continue;
      }
      await write.mutate(
        `mutation ($board: ID!, $item: ID!, $col: String!, $val: String!) {
           change_simple_column_value(board_id: $board, item_id: $item, column_id: $col, value: $val) { id }
         }`,
        { board: THEMAS_BOARD, item: item.id, col: kolom, val: code },
        // De WAARDE hoort in de sleutel: Monday onderdrukt dezelfde sleutel 30 minuten, dus
        // een correctie kort na een verkeerde schrijfactie zou anders stil verdampen.
        { idempotencyKey: `themas-mc-seed:${THEMAS_BOARD}:${item.id}:${kolom}:${code}` }
      );
      geschreven += 1;
    }
  }

  console.log(`\n  ${apply ? 'geschreven' : 'zou schrijven'}: ${geschreven}`);
  console.log(`  al goed          : ${ongewijzigd}`);
  console.log(`  overgeslagen     : ${overgeslagen} (dubbele itemnaam)`);
  console.log(`  gewist           : ${gewist} (botsing, of geen geldige code)`);
  if (uit.geenCode.length > 0) {
    console.log(`\n  GEEN CODE maar een notitie in het werkblad: ${uit.geenCode.length}`);
    for (const g of uit.geenCode) {
      console.log(`    ${g.thema} / ${g.label}: ${JSON.stringify(g.waarde)} (via "${g.via}")`);
    }
  }

  console.log(`\n  LEEG GELATEN, botsende cellen: ${uit.botsingen.length}`);
  for (const b of uit.botsingen) {
    console.log(
      `    ${b.thema} / ${b.label}: ${b.kandidaten.map((k) => `${k.code} (via "${k.via}")`).join('  vs  ')}`
    );
  }
  console.log(`\n  Niet gekoppeld (wacht op ITG): ${uit.ongekoppeld.length}`);
  for (const n of uit.ongekoppeld) {
    console.log(`    ${n}`);
  }
  if (!apply) {
    console.log('\n  DROOGLOOP — er is niets gewijzigd.\n');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
