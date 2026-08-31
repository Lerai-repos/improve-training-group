/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { AGENDA_2026_COLUMNS, MONDAY_API_VERSION, agendaBoardId } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { trainerRelationIds } from '@lib/monday/decode';
import { readAgendaScan } from '@lib/recommend/assignments';
import { readBriefingTraining } from '@lib/briefing/read';
import { generateBriefings } from '@lib/briefing/generate';
import { readHistorie } from '@lib/briefing/historie';
import { readExtraInfo } from '@lib/briefing/updates';
import { buildTabView } from '@lib/briefing/tab';
import { prefillTrainingActor, EMPTY_CHECKLIST } from '@lib/briefing/blocks';
import { countLinkedActors } from '@lib/briefing/compose';

import type { BriefingTraining } from '@lib/briefing/types';

/**
 * Wat er gebeurt als de briefing over ITG's ECHTE bord loopt.
 *
 * Leest alleen. Rendert niet en schrijft niets: dit gaat over de gegevens, niet over de
 * documenten. Per komende training wordt dezelfde beslissing genomen als in de app-tab, en
 * geteld wat er stukloopt of als «…» in het document zou landen.
 *
 * De acteurvraag wordt beantwoord met Monday's eigen voorstel. Anders blokkeert élke
 * training op "nog niet beantwoord" en meet je dat niemand het formulier heeft ingevuld,
 * in plaats van de kwaliteit van de gegevens.
 */

const GELIJKTIJDIG = 6;

/** `--render` bouwt de documenten echt; zonder vlag blijft het bij de gegevenscontrole. */
const RENDER = process.argv.includes('--render');

interface Uitslag {
  itemId: string;
  naam: string;
  label: string;
  datum: string | null;
  fout?: string;
  blokkeert: string[];
  legeVelden: string[];
  documenten: number;
  geenThemaInhoud: boolean;
  themas: readonly string[];
  /** Pass 2: wat het renderen deed. Leeg zolang alleen pass 1 draait. */
  renderFout?: string;
  openPerRol: { rol: string; velden: readonly string[] }[];
  /** Hoeveel mensen er in de leadkolom staan. 0 = nog niet bemand, 2+ = onbeslisbaar. */
  leads: number;
}

type Client = ReturnType<typeof createMondayGraphQLClient>;

/**
 * Pass 2: het document ECHT bouwen, zonder reis.
 *
 * Reistijd kost een LLM-adresclassificatie plus Google-routes per trainer, en daar zit het
 * documentrisico niet. Sjablonen, historie, gemarkeerde updates en de rolblokken zijn gratis
 * en lokaal, en dat is precies waar een training stuk kan lopen op een manier die de planner
 * niet kan verklaren.
 */
async function render(
  client: Client,
  training: BriefingTraining,
  view: ReturnType<typeof buildTabView>
): Promise<{ fout?: string; openPerRol: { rol: string; velden: readonly string[] }[] }> {
  try {
    const extraInfo = await readExtraInfo(client, [training.itemId, training.opportunityItemId]);
    const historie = await readHistorie(client, {
      bedrijf: training.opdrachtgever,
      excludeItemId: training.itemId,
    });
    const uit = await generateBriefings(training, view.checklist, {
      historie,
      extraInfo: extraInfo.lines,
      reis: new Map(),
      actorItemIds: view.actorItemIds,
    });
    if (uit.kind === 'refused') {
      return { fout: `geweigerd: ${uit.reason}`, openPerRol: [] };
    }
    return {
      openPerRol: uit.documents.map((d) => ({ rol: d.role, velden: d.open })),
    };
  } catch (error) {
    return { fout: error instanceof Error ? error.message : String(error), openPerRol: [] };
  }
}

async function beoordeel(client: Client, itemId: string, boardId: string): Promise<Uitslag> {
  const basis: Uitslag = {
    itemId,
    naam: '?',
    label: '?',
    datum: null,
    blokkeert: [],
    legeVelden: [],
    documenten: 0,
    geenThemaInhoud: false,
    themas: [],
    leads: 0,
    openPerRol: [],
  };
  let training: BriefingTraining;
  try {
    training = await readBriefingTraining(client, itemId, { boardId });
  } catch (error) {
    return { ...basis, fout: error instanceof Error ? error.message : String(error) };
  }

  const voorstel = prefillTrainingActor(training.acteuraantal, countLinkedActors(training));
  const view = buildTabView(training, {
    checklist: { ...EMPTY_CHECKLIST, trainingActor: voorstel },
    actorItemIds: [],
    actorAnswered: true,
  });

  const blokkeert = view.issues.filter((i) => i.blokkeert).map((i) => i.kind);
  const gerenderd =
    blokkeert.length === 0 && RENDER
      ? await render(client, training, view)
      : { openPerRol: [] as { rol: string; velden: readonly string[] }[] };

  return {
    itemId,
    naam: training.naam,
    label: training.label,
    datum: training.datum,
    renderFout: 'fout' in gerenderd ? gerenderd.fout : undefined,
    openPerRol: gerenderd.openPerRol,
    blokkeert,
    legeVelden: training.missing.map((m) => m.label),
    documenten: view.documenten.length,
    geenThemaInhoud: (training.themaInhoud ?? '').trim() === '',
    themas: training.themas,
    leads: training.trainers.filter((t) => !t.isCoTrainer).length,
  };
}

async function main(): Promise<void> {
  /**
   * De eerste NIET-vlag is de begindatum.
   *
   * `process.argv[2]` pakken maakt van `--render` de datum, en dan gaat het stil mis in
   * plaats van luid: elke ISO-datum is als tekst groter dan `--render`, dus de scan pakt
   * ook alle trainingen uit het verleden mee en rapporteert die als komend. Een verkeerde
   * vorm hoort te falen, niet de scope te verdubbelen.
   */
  const losseArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const vanaf = losseArgs[0] ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(vanaf)) {
    throw new Error(`Begindatum moet YYYY-MM-DD zijn, kreeg ${JSON.stringify(vanaf)}`);
  }
  if (losseArgs.length > 1) {
    throw new Error(`Onverwachte argumenten: ${losseArgs.slice(1).join(' ')}`);
  }
  const boardId = agendaBoardId();
  const client = createMondayGraphQLClient({
    token: process.env.MONDAY_API_TOKEN ?? '',
    apiVersion: MONDAY_API_VERSION,
    deadlineMs: () => Date.now() + 180_000,
  });

  const scan = await readAgendaScan(client, {
    boardId,
    dateColumnId: AGENDA_2026_COLUMNS.datum,
    trainerColumnIds: trainerRelationIds(AGENDA_2026_COLUMNS),
  });
  const ids = [...scan.dateByItemId]
    .filter(([, datum]) => datum !== null && datum >= vanaf)
    .sort((a, b) => (a[1] ?? '').localeCompare(b[1] ?? ''))
    .map(([id]) => id);

  console.log(`Bord ${boardId}: ${ids.length} komende trainingen vanaf ${vanaf}\n`);

  const uit: Uitslag[] = [];
  for (let i = 0; i < ids.length; i += GELIJKTIJDIG) {
    const groep = ids.slice(i, i + GELIJKTIJDIG);
    uit.push(...(await Promise.all(groep.map((id) => beoordeel(client, id, boardId)))));
    process.stderr.write(`\r  ${uit.length}/${ids.length}`);
  }
  process.stderr.write('\n\n');

  const fouten = uit.filter((u) => u.fout !== undefined);
  const geblokkeerd = uit.filter((u) => u.fout === undefined && u.blokkeert.length > 0);
  const goed = uit.filter((u) => u.fout === undefined && u.blokkeert.length === 0);

  console.log(`GENEREERT:      ${goed.length}`);
  console.log(`GEBLOKKEERD:    ${geblokkeerd.length}`);
  console.log(`LEESFOUT:       ${fouten.length}\n`);

  const tel = (
    lijst: Uitslag[],
    sleutel: (u: Uitslag) => readonly string[]
  ): Map<string, number> => {
    const m = new Map<string, number>();
    for (const u of lijst) {
      for (const k of sleutel(u)) {
        m.set(k, (m.get(k) ?? 0) + 1);
      }
    }
    return new Map([...m].sort((a, b) => b[1] - a[1]));
  };

  /**
   * "Geen lead" is twee heel verschillende dingen en die mogen niet op één hoop.
   *
   * Nul mensen in de leadkolom = de training is nog niet bemand. Dat is geen datafout maar
   * gewoon werk dat nog moet gebeuren, en het zou ITG op jacht sturen naar niets. Twee of
   * meer = de legacy-toestand waar niemand kan zeggen wie de lead is; DAT moeten ze opruimen.
   */
  const nietBemand = geblokkeerd.filter((u) => u.blokkeert.includes('geen_lead') && u.leads === 0);
  const teVeelLeads = geblokkeerd.filter((u) => u.blokkeert.includes('geen_lead') && u.leads > 1);

  console.log('Waarom geblokkeerd:');
  console.log(
    `  ${String(nietBemand.length).padStart(4)}  nog geen trainer gekoppeld (geen datafout, gewoon nog niet ingepland)`
  );
  console.log(
    `  ${String(teVeelLeads.length).padStart(4)}  twee of meer in de leadkolom (LEGACY: ITG moet co-trainers verplaatsen)`
  );
  for (const [kind, n] of tel(geblokkeerd, (u) =>
    [...new Set(u.blokkeert)].filter((k) => k !== 'geen_lead')
  )) {
    console.log(`  ${String(n).padStart(4)}  ${kind}`);
  }

  const themaTel = tel(
    uit.filter((u) => u.geenThemaInhoud),
    (u) => u.themas
  );
  console.log("\nThema's zonder concept-inhoud, en hoe vaak ze voorkomen:");
  for (const [thema, n] of themaTel) {
    console.log(`  ${String(n).padStart(4)}  ${thema}`);
  }

  console.log('\nLege velden (worden een zichtbare «…»-regel):');
  for (const [veld, n] of tel(uit, (u) => u.legeVelden)) {
    console.log(`  ${String(n).padStart(4)}  ${veld}`);
  }

  const zonderThema = uit.filter((u) => u.fout === undefined && u.geenThemaInhoud);
  console.log(`\nZonder concept-inhoud op het thema: ${zonderThema.length}`);

  if (fouten.length > 0) {
    console.log('\nLEESFOUTEN:');
    const perBoodschap = tel(fouten, (u) => [u.fout ?? '']);
    for (const [boodschap, n] of perBoodschap) {
      console.log(`  ${String(n).padStart(4)}  ${boodschap.slice(0, 140)}`);
    }
  }

  if (RENDER) {
    const gerenderd = goed.filter((u) => u.renderFout === undefined);
    const stuk = goed.filter((u) => u.renderFout !== undefined);
    console.log(`\nRENDERT SCHOON: ${gerenderd.length}`);
    console.log(`RENDERFOUT:     ${stuk.length}`);
    if (stuk.length > 0) {
      console.log('\nRenderfouten:');
      for (const [boodschap, n] of tel(stuk, (u) => [u.renderFout ?? ''])) {
        console.log(`  ${String(n).padStart(4)}  ${boodschap.slice(0, 150)}`);
      }
      console.log('\n  eerste vijf:');
      for (const u of stuk.slice(0, 5)) {
        console.log(
          `    ${u.datum}  ${u.label.padEnd(4)} ${u.naam.slice(0, 38).padEnd(38)} (${u.itemId})`
        );
      }
    }
    const perRol = new Map<string, Map<string, number>>();
    for (const u of gerenderd) {
      for (const doc of u.openPerRol) {
        const m = perRol.get(doc.rol) ?? new Map<string, number>();
        for (const veld of doc.velden) {
          m.set(veld, (m.get(veld) ?? 0) + 1);
        }
        perRol.set(doc.rol, m);
      }
    }
    const documenten = gerenderd.reduce((n, u) => n + u.openPerRol.length, 0);
    console.log(`\n«…»-regels per rol, over ${documenten} documenten:`);
    for (const [rol, velden] of perRol) {
      const totaal = gerenderd.reduce(
        (n, u) => n + u.openPerRol.filter((d) => d.rol === rol).length,
        0
      );
      console.log(`  ${rol} (${totaal} documenten)`);
      for (const [veld, n] of [...velden].sort((a, b) => b[1] - a[1])) {
        console.log(`      ${String(n).padStart(4)}  ${veld}`);
      }
    }
  }

  console.log('\nTe veel leads (dit is de lijst voor ITG):');
  for (const u of teVeelLeads) {
    console.log(
      `  ${u.datum}  ${u.label.padEnd(4)} ${u.naam.slice(0, 44).padEnd(44)} ${u.leads} in leadkolom  (${u.itemId})`
    );
  }

  console.log('\nAlle geblokkeerde trainingen:');
  for (const u of geblokkeerd.slice(0, 40)) {
    console.log(
      `  ${u.datum}  ${u.label.padEnd(4)} ${u.naam.slice(0, 40).padEnd(40)} ${u.blokkeert.join(', ')}  (${u.itemId})`
    );
  }
  if (geblokkeerd.length > 40) {
    console.log(`  ... en nog ${geblokkeerd.length - 40}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
