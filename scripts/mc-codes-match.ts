/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { readFileSync } from 'node:fs';

import { MONDAY_API_VERSION, THEMAS_BOARD } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';

/**
 * De themanamen uit ITG's codebestand naast de thema's op het Themabord.
 *
 * Leest alleen en schrijft niets. Koppelt ALLEEN bij een letterlijke naamsgelijkheid of een
 * met de hand gelegde kaart, precies zoals `themas-conceptinhoud.ts` dat doet en om dezelfde
 * reden: normaliseren zou `Klantgericht werken` aan `Oplossingsgericht werken` kunnen knopen,
 * en dan staat de productcode van een ánder thema in een briefing bij de klant.
 *
 * Wat niet koppelt komt in een lijst met suggesties. Die suggesties zijn een hint voor een
 * mens, nooit een automatische keuze.
 */

const XLSX =
  'docs/Improve Training Group/Shared/Briefing bestanden/ITG - Productcodes Monday Challenges.xlsx';

/** Blok in het werkblad: labelcode, kolom met de trainingsnaam, kolom met de productcode. */
const BLOKKEN: readonly [string, string, string][] = [
  ['IT', 'A', 'B'],
  ['JE', 'D', 'E'],
  ['TT', 'G', 'H'],
  ['SST', 'J', 'K'],
  ['FV', 'M', 'N'],
  ['WJ', 'P', 'Q'],
  ['CC', 'S', 'T'],
  ['CP', 'V', 'W'],
];

interface ThemaMap {
  kaart: Record<string, string>;
  geenThema: Record<string, string>;
  openVraag: Record<string, string>;
}

function leesBlad(): Map<string, Map<string, string>> {
  // Geen xlsx-bibliotheek: een .xlsx is een zip met XML, en dit is de enige plek die hem leest.
  const { execSync } = require('node:child_process') as typeof import('node:child_process');
  const json = execSync(`python3 tools/mc-codes/extract.py ${JSON.stringify(XLSX)}`, {
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const rauw = JSON.parse(json) as Record<string, Record<string, string>>;
  const uit = new Map<string, Map<string, string>>();
  for (const [thema, perLabel] of Object.entries(rauw)) {
    uit.set(thema, new Map(Object.entries(perLabel)));
  }
  return uit;
}

/** Ruwe gelijkenis, puur om een mens een kandidaat aan te reiken. Beslist nooit iets. */
function lijkt(a: string, b: string): number {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (x === y) {
    return 1;
  }
  if (x.includes(y) || y.includes(x)) {
    return 0.8;
  }
  const woorden = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const andere = b.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const gedeeld = andere.filter((w) => woorden.has(w)).length;
  return gedeeld === 0 ? 0 : gedeeld / Math.max(woorden.size, andere.length);
}

async function main(): Promise<void> {
  const client = createMondayGraphQLClient({
    token: process.env.MONDAY_API_TOKEN ?? '',
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: () => Date.now() + 120_000,
  });
  const data = await client.query<{ boards: { items_page: { items: { id: string; name: string }[] } }[] }>(
    `query ($board: [ID!]) { boards(ids:$board){ items_page(limit:500){ items { id name } } } }`,
    { board: [THEMAS_BOARD] }
  );
  const bordThemas = (data.boards[0]?.items_page.items ?? []).map((i) => i.name);
  const bordSet = new Set(bordThemas);

  const map = JSON.parse(readFileSync('tools/skeletten/thema-map.json', 'utf-8')) as ThemaMap;
  /**
   * Onze eigen kaart voor dit bestand, bovenop die van de skeletten.
   *
   * ITG schrijft dezelfde training in de twee bestanden anders op, dus de skelettenkaart
   * dekt maar een deel. Deze staat apart zodat duidelijk blijft welke koppeling waarvoor is
   * gelegd en nagelopen.
   */
  const eigen = JSON.parse(readFileSync('tools/mc-codes/thema-map.json', 'utf-8')) as ThemaMap;
  map.kaart = { ...map.kaart, ...eigen.kaart };
  map.openVraag = { ...map.openVraag, ...eigen.openVraag };
  const codes = leesBlad();

  console.log(`Themabord: ${bordThemas.length} thema's`);
  console.log(`Codebestand: ${codes.size} unieke themanamen over ${BLOKKEN.length} labels\n`);

  const gekoppeld: { naam: string; bord: string; via: string; codes: number }[] = [];
  const open: { naam: string; codes: string[]; suggesties: string[]; dichtstbij: string[] }[] = [];
  /** Bij de skeletten al vastgesteld dat er geen bordthema is. */
  const alBeslist: { naam: string; reden: string; codes: string[] }[] = [];
  /** Bij de skeletten al aan ITG voorgelegd; wacht op hetzelfde antwoord. */
  const alGevraagd: { naam: string; reden: string; codes: string[] }[] = [];

  /** Dubbele itemnamen op het bord: dan is "de" tegenhanger niet eenduidig. */
  const dubbel = [...new Map<string, number>(
    bordThemas.map((b) => [b, bordThemas.filter((x) => x === b).length])
  )].filter(([, n]) => n > 1);

  for (const [naam, perLabel] of [...codes].sort((a, b) => a[0].localeCompare(b[0]))) {
    const viaKaart = map.kaart[naam];
    if (bordSet.has(naam)) {
      gekoppeld.push({ naam, bord: naam, via: 'letterlijk gelijk', codes: perLabel.size });
    } else if (viaKaart !== undefined && bordSet.has(viaKaart)) {
      gekoppeld.push({ naam, bord: viaKaart, via: 'skelettenkaart', codes: perLabel.size });
    } else if (map.geenThema[naam] !== undefined) {
      /**
       * Bij de skeletten al uitgezocht: dit thema bestaat niet op het bord, met reden.
       * Opnieuw voorleggen is ITG vragen naar iets wat ze al beantwoord hebben.
       */
      alBeslist.push({ naam, reden: map.geenThema[naam], codes: [...perLabel].map(([l, c]) => `${l}=${c}`) });
    } else if (map.openVraag[naam] !== undefined) {
      alGevraagd.push({ naam, reden: map.openVraag[naam], codes: [...perLabel].map(([l, c]) => `${l}=${c}`) });
    } else {
      /**
       * Ook de kaart-WAARDEN meewegen, niet alleen de sleutels.
       *
       * ITG schrijft dezelfde training in twee bestanden anders op: het skelettenbestand
       * zegt "Ademhaling voor Focus en rust", het codebestand "Ademhaling voor rust en
       * focus", en het bord zegt "Ademen". Zonder deze stap melden we dat er geen
       * tegenhanger is en gaat ITG zoeken naar iets dat er wél is.
       */
      const gerangschikt = [...new Set(bordThemas)]
        .map((b) => {
          const viaSkelet = Object.entries(map.kaart)
            .filter(([, bord]) => bord === b)
            .map(([skelet]) => lijkt(naam, skelet));
          return [b, Math.max(lijkt(naam, b), ...viaSkelet, 0)] as const;
        })
        .sort((a, b) => b[1] - a[1]);
      open.push({
        naam,
        codes: [...perLabel].map(([label, code]) => `${label}=${code}`),
        suggesties: gerangschikt.filter(([, score]) => score >= 0.5).slice(0, 3).map(([b]) => b),
        // Ook zonder drempel de beste drie, zodat "geen tegenhanger" na te kijken is.
        dichtstbij: gerangschikt.slice(0, 3).map(([b, score]) => `${b} (${score.toFixed(2)})`),
      });
    }
  }

  const codesGekoppeld = gekoppeld.reduce((n, g) => n + g.codes, 0);
  const codesOpen = open.reduce((n, o) => n + o.codes.length, 0);
  console.log(`GEKOPPELD:      ${gekoppeld.length} namen  (${codesGekoppeld} codes)`);
  console.log(`NIET GEKOPPELD: ${open.length} namen  (${codesOpen} codes)\n`);

  /**
   * Wie beslist wat.
   *
   * Eén kandidaat is werk voor ons: dat is dezelfde lange-marketingnaam-tegen-korte-bordnaam
   * die de skelettenkaart al 41 keer met de hand oploste. Twee of meer kandidaten, of geen
   * enkele, is een vraag aan ITG — daar gokken zet de productcode van een ánder thema in een
   * briefing bij de klant.
   */
  const wijLeggen = open.filter((o) => o.suggesties.length === 1);
  const ambigu = open.filter((o) => o.suggesties.length > 1);
  const geenKandidaat = open.filter((o) => o.suggesties.length === 0);

  console.log(`  wij kunnen leggen (één kandidaat) : ${wijLeggen.length} namen`);
  console.log(`  ITG moet kiezen (meer kandidaten) : ${ambigu.length} namen`);
  console.log(`  geen tegenhanger op het bord      : ${geenKandidaat.length} namen\n`);

  const toon = (titel: string, lijst: typeof open): void => {
    console.log(`\n=== ${titel} ===\n`);
    for (const o of lijst) {
      console.log(`  ${o.naam}`);
      console.log(`      codes    : ${o.codes.join('  ')}`);
      if (o.suggesties.length > 0) {
        console.log(`      kandidaat: ${o.suggesties.join('  |  ')}`);
      } else {
        console.log(`      dichtstbij: ${o.dichtstbij.join('  |  ')}`);
      }
    }
  };

  if (dubbel.length > 0) {
    console.log('\nLET OP, dubbele itemnamen op het Themabord:');
    for (const [naam, n] of dubbel) {
      console.log(`  ${n}x  ${naam}`);
    }
  }

  if (alBeslist.length > 0) {
    console.log('\n=== AL BESLIST bij de skeletten: geen bordthema ===\n');
    for (const o of alBeslist) {
      console.log(`  ${o.naam}  (${o.codes.join('  ')})`);
      console.log(`      ${o.reden}`);
    }
  }
  if (alGevraagd.length > 0) {
    console.log('\n=== AL GEVRAAGD bij de skeletten, zelfde antwoord telt hier ===\n');
    for (const o of alGevraagd) {
      console.log(`  ${o.naam}  (${o.codes.join('  ')})`);
    }
  }

  toon('WIJ LEGGEN DEZE (nalopen, dan in de kaart)', wijLeggen);
  toon('ITG MOET KIEZEN: meer dan één kandidaat', ambigu);
  toon('ITG MOET ZEGGEN: geen tegenhanger op het bord', geenKandidaat);

  /**
   * Twee namen op één bordthema is alleen een probleem als ze dezelfde LABELKOLOM claimen.
   *
   * De skeletvraag ("welke tekst wint?") is een andere vraag dan deze. `Succesvol
   * veranderen` en `Gewoontes en patronen veranderen` wijzen allebei naar `Veranderen`, maar
   * als de een IT/JE/SST/CC vult en de ander FV/WJ, dan passen ze gewoon naast elkaar in
   * dezelfde rij en valt er niets te kiezen.
   */
  const perThemaLabel = new Map<string, Map<string, { code: string; via: string }[]>>();
  for (const g of gekoppeld) {
    for (const [label, code] of codes.get(g.naam) ?? []) {
      const perLabel = perThemaLabel.get(g.bord) ?? new Map<string, { code: string; via: string }[]>();
      perLabel.set(label, [...(perLabel.get(label) ?? []), { code, via: g.naam }]);
      perThemaLabel.set(g.bord, perLabel);
    }
  }
  const botsingen: string[] = [];
  for (const [thema, perLabel] of perThemaLabel) {
    for (const [label, lijst] of perLabel) {
      const uniek = [...new Set(lijst.map((l) => l.code))];
      if (uniek.length > 1) {
        botsingen.push(
          `${thema} / ${label}: ${lijst.map((l) => `${l.code} (via "${l.via}")`).join('  vs  ')}`
        );
      }
    }
  }
  console.log(`\nECHTE BOTSINGEN (zelfde thema + zelfde label, twee codes): ${botsingen.length}`);
  for (const b of botsingen) {
    console.log(`  ${b}`);
  }

  const bordZonderCode = bordThemas.filter(
    (b) => ![...gekoppeld].some((g) => g.bord === b)
  );
  console.log(`\nThema's OP het bord zonder enige code: ${bordZonderCode.length}`);
  for (const b of bordZonderCode) {
    console.log(`  ${b}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
