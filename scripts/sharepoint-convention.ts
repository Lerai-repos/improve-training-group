/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { siteConfigFromEnv } from '@lib/sharepoint/config';
import { createGraphClient, graphConfigFromEnv } from '@lib/sharepoint/graph';
import { matchKlantenFolder, matchLabelFolder } from '@lib/sharepoint/paths';
import { createSharePointStore, resolveSiteId } from '@lib/sharepoint/store';

/**
 * Hoe bergt ITG een briefing op: los in de klantmap, of in een submap per sessie?
 *
 * Leest alleen. Bij Repair care bleek de klantmap alleen submappen te bevatten
 * (`Digital detoxen; 22-1-2026`) met de briefing erin — terwijl onze code het document
 * rechtstreeks in de klantmap zet. De vraag is of dat één label is of alle negen.
 */

const LABELS = ['IT', 'WJ', 'JE', 'FV', 'SST', 'TT', 'CC', 'CP', 'FT'] as const;
/** Genoeg klanten per label om een patroon te zien zonder honderden verzoeken. */
const PER_LABEL = 14;

interface Telling {
  klanten: number;
  alleenSubmappen: number;
  alleenBestanden: number;
  gemengd: number;
  leeg: number;
  voorbeelden: string[];
  briefingLos: number;
  briefingInSubmap: number;
}

const isBriefing = (naam: string): boolean => /^briefing/i.test(naam);

async function main(): Promise<void> {
  const site = siteConfigFromEnv();
  const graph = createGraphClient(graphConfigFromEnv());
  const store = createSharePointStore(graph, await resolveSiteId(graph, site));
  const wortel = await store.children(site.root);

  for (const label of LABELS) {
    /**
     * Niet gevonden is een BEVINDING, geen reden om door te lopen.
     *
     * Stilletjes overslaan levert een rapport op dat compleet lijkt maar een label mist, en
     * dan lees je "geen submappen" als een meting terwijl er niets gemeten is. Let op: er
     * bestaan mappen die op een label lijken zonder het te zijn — `0. ITG` is ITG's eigen
     * map en `10. ST` is een ánder label. Daarom exacte overeenkomst en geen aliassen: `IT`
     * naar `0. ITG` laten wijzen zou elke IT-briefing in hun interne map zetten.
     */
    const labelMatch = matchLabelFolder(wortel, label);
    if (labelMatch.kind !== 'found') {
      console.log(`\n### ${label}  — GEEN LABELMAP (${labelMatch.kind}); niets gemeten`);
      continue;
    }
    const labelPad = `${site.root}/${labelMatch.name}`;
    const klantenMatch = matchKlantenFolder(await store.children(labelPad));
    if (klantenMatch.kind !== 'found') {
      console.log(
        `\n### ${label}  — geen Klantenmap in "${labelMatch.name}" (${klantenMatch.kind}); niets gemeten`
      );
      continue;
    }
    const klantenPad = `${labelPad}/${klantenMatch.name}`;

    /**
     * Jaarmappen zijn geen klanten; één niveau dieper kijken waar ze bestaan.
     *
     * Per jaar een eigen lijstje, en dan om de beurt één klant pakken. Twee eerdere versies
     * gingen hier de mist in, allebei ten koste van het RECENTSTE jaar — en dat is nu net
     * het jaar waarin de gewoonte van vandaag zichtbaar is:
     *
     *  1. de eerste N paden nemen: de jaarmappen staan op naam gesorteerd, dus de hele
     *     FV-steekproef kwam uit `2025` en `2026` deed niet mee;
     *  2. met een vaste stap door de aaneengeschakelde lijst lopen: bij 100 oude, 10
     *     tussenliggende en 5 huidige klanten is de stap 9 en is de laatste index 108,
     *     terwijl het huidige jaar pas bij 110 begint. Weer weg.
     *
     * Om de beurt kan dat niet: elk jaar levert zijn eerste klant vóórdat welk jaar dan ook
     * een tweede levert.
     */
    const top = await store.children(klantenPad);
    const perJaar = new Map<string, string[]>();
    for (const naam of top) {
      if (/^(19|20)\d{2}$/.test(naam)) {
        perJaar.set(
          naam,
          (await store.children(`${klantenPad}/${naam}`)).map((k) => `${klantenPad}/${naam}/${k}`)
        );
      } else {
        const los = perJaar.get('(los)') ?? [];
        los.push(`${klantenPad}/${naam}`);
        perJaar.set('(los)', los);
      }
    }
    const groepen = [...perJaar.values()];
    const paden: string[] = [];
    for (let ronde = 0; paden.length < PER_LABEL; ronde += 1) {
      const voor = paden.length;
      for (const groep of groepen) {
        if (ronde < groep.length && paden.length < PER_LABEL) {
          paden.push(groep[ronde]);
        }
      }
      // Niets meer bijgekomen: alle groepen zijn op, anders loopt dit eeuwig door.
      if (paden.length === voor) {
        break;
      }
    }

    const t: Telling = {
      klanten: 0,
      alleenSubmappen: 0,
      alleenBestanden: 0,
      gemengd: 0,
      leeg: 0,
      voorbeelden: [],
      briefingLos: 0,
      briefingInSubmap: 0,
    };

    for (const pad of paden.slice(0, PER_LABEL)) {
      const [submappen, bestanden] = await Promise.all([store.children(pad), store.files(pad)]);
      t.klanten += 1;
      if (submappen.length > 0 && bestanden.length === 0) {
        t.alleenSubmappen += 1;
      } else if (submappen.length === 0 && bestanden.length > 0) {
        t.alleenBestanden += 1;
      } else if (submappen.length === 0 && bestanden.length === 0) {
        t.leeg += 1;
      } else {
        t.gemengd += 1;
      }
      if (bestanden.some(isBriefing)) {
        t.briefingLos += 1;
      }
      /**
       * ÁLLE submappen, niet de eerste paar.
       *
       * De klantensteekproef is al begrensd; hierbinnen afkappen maakt van "geen briefing in
       * een submap" een uitspraak over de eerste drie mappen die als uitspraak over de
       * klant werd gelezen. Juist een klant met veel sessies — waar de submapgewoonte het
       * waarschijnlijkst is — verliest dan zijn bewijs.
       */
      for (const sub of submappen) {
        const erin = await store.files(`${pad}/${sub}`);
        if (erin.some(isBriefing)) {
          t.briefingInSubmap += 1;
          if (t.voorbeelden.length < 3) {
            t.voorbeelden.push(`${sub}/  →  ${erin.filter(isBriefing)[0]}`);
          }
          break;
        }
      }
    }

    console.log(`\n### ${label}  →  "${labelMatch.name}"  (${t.klanten} klantmappen bekeken)`);
    if (t.klanten === 0) {
      console.log('  geen klantmappen onder Klanten — niets te meten, geen bevinding');
      continue;
    }
    console.log(
      `  alleen submappen: ${t.alleenSubmappen} | alleen bestanden: ${t.alleenBestanden} | gemengd: ${t.gemengd} | leeg: ${t.leeg}`
    );
    console.log(
      `  klantmappen met een briefing LOS: ${t.briefingLos} | met een briefing IN een submap: ${t.briefingInSubmap}`
    );
    for (const v of t.voorbeelden) {
      console.log(`    ${v}`);
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
