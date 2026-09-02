/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { labelsBoardId } from '@lib/labels';
import { readLabels } from '@lib/labels/read';
import { MONDAY_API_VERSION } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { fetchArtwork } from '@lib/report/assets';
import { chartColours } from '@lib/report/colours';
import { buildReportModel } from '@lib/report/model';
import { createPdfRenderer } from '@lib/report/pdf';
import { renderReportHtml } from '@lib/report/template';

import type { EvaluationResponse } from '@lib/evaluations/types';
import type { LabelCode } from '@lib/labels';

/**
 * Eén echt rapport renderen om naar te kijken. ONTWIKKELGEREEDSCHAP, geen productiepad.
 *
 * Leest de responses uit de CSV-export in `docs/` in plaats van uit Google Sheets, zodat er
 * geen OAuth voor nodig is, maar haalt de huisstijl en de afbeeldingen WEL live van het
 * Labels-bord — dat is juist het stuk dat bewezen moet worden.
 *
 *   pnpm report:demo 251050 IT
 *   pnpm report:demo 251050 FV --out /tmp/fv.pdf
 */

const EXIT_FAILURE = 1;
/** Genegeerde map: een rapport bevat klantnamen en letterlijke deelnemersantwoorden. */
const OUT_DIR = join(process.cwd(), 'report-output');
const OWNER_ONLY = 0o600;
/**
 * De CSV-export staat NIET in de repo: `.gitignore` sluit `/docs/*` uit op `m2a` en `m2b` na,
 * en dit bestand bevat de letterlijke antwoorden van deelnemers — dat hoort er ook niet in.
 *
 * Vandaar `--csv <pad>`, met deze plek als gemak voor wie de export al heeft staan. Ontbreekt
 * hij, dan zegt dit script wat je moet doen in plaats van te struikelen over een ENOENT.
 */
const DEFAULT_CSV = join(
  process.cwd(),
  'docs/1.0 Individuele Evaluatie - NL (Antwoorden) - Formulierreacties 1.csv'
);

/** Kolomposities in de export. Vast, want dit bestand is een momentopname en geen live bron. */
const COL = {
  code: 1,
  program: 2,
  practical: 3,
  tools: 4,
  trainerExpertise: 5,
  trainerCommunication: 6,
  grade: 7,
  followUp: 8,
  positive: 9,
  improvement: 10,
} as const;

/** Minimale CSV-lezer: velden tussen dubbele quotes, verdubbelde quote is een letterlijke. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const num = (raw: string | undefined): number | null => {
  const value = Number.parseFloat((raw ?? '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};
const str = (raw: string | undefined): string | null => {
  const value = (raw ?? '').trim();
  return value === '' ? null : value;
};

function responsesFor(code: string, csvPath: string): EvaluationResponse[] {
  if (!existsSync(csvPath)) {
    throw new Error(
      `Geen CSV-export gevonden op ${csvPath}.\n` +
        'Deze staat bewust niet in de repo (deelnemersantwoorden). Geef er een mee met ' +
        '--csv <pad>, of gebruik `pnpm report:generate <item-id>` — die leest live uit ' +
        'Google Sheets en heeft dit bestand niet nodig.'
    );
  }
  const rows = parseCsv(readFileSync(csvPath, 'utf8')).slice(1);
  const out: EvaluationResponse[] = [];
  rows.forEach((row, index) => {
    if ((row[COL.code] ?? '').trim() !== code) {
      return;
    }
    out.push({
      source: { documentId: 'csv:demo', sheetName: 'Formulierreacties 1', label: 'nl' },
      rowNumber: index + 2,
      rawCode: code,
      grade: num(row[COL.grade]),
      receivedAtRaw: str(row[0]),
      answers: {
        program: num(row[COL.program]),
        practical: num(row[COL.practical]),
        tools: num(row[COL.tools]),
        trainerExpertise: num(row[COL.trainerExpertise]),
        trainerCommunication: num(row[COL.trainerCommunication]),
        followUp: str(row[COL.followUp]),
        positive: str(row[COL.positive]),
        improvement: str(row[COL.improvement]),
      },
    });
  });
  return out;
}

async function main(): Promise<void> {
  const [code, labelArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex === -1 ? join(OUT_DIR, 'report-demo.pdf') : process.argv[outIndex + 1];

  if (!code || !labelArg) {
    throw new Error(
      'Gebruik: pnpm report:demo <ie-code> <labelcode> [--csv <pad>] [--out bestand.pdf]'
    );
  }
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }

  const csvIndex = process.argv.indexOf('--csv');
  const csvPath = csvIndex === -1 ? DEFAULT_CSV : process.argv[csvIndex + 1];
  const responses = responsesFor(code, csvPath);
  if (responses.length === 0) {
    throw new Error(`Geen responses met code "${code}" in de CSV-export.`);
  }
  console.log(`\n  ${responses.length} responses voor code ${code}`);

  const client = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const labels = await readLabels(client, labelsBoardId());
  const label = labels.get(labelArg as LabelCode);
  if (label === undefined) {
    throw new Error(`Label "${labelArg}" staat niet op het Labels-bord.`);
  }
  console.log(`  label ${label.code} — ${label.volledigeNaam} (${label.kleur})`);

  const started = Date.now();
  const artwork = await fetchArtwork(label);
  const mb = (n: number | undefined): string =>
    n === undefined ? '—' : `${(n / 1024 / 1024).toFixed(2)} MB`;
  console.log(
    `  afbeeldingen: logo ${mb(artwork.logo?.bytes)}, voorblad ${mb(artwork.voorblad?.bytes)}, ` +
      `achterblad ${mb(artwork.achterblad?.bytes)}  (${Date.now() - started} ms)`
  );
  for (const problem of artwork.problems) {
    console.log(`  LET OP: ${problem}`);
  }

  const model = buildReportModel({
    training: {
      itemId: 'demo',
      klanttitel: 'Feedback geven & ontvangen',
      contactPersoon: 'Lisa de Vries, Mark Jansen',
      trainerNamen: ['Jan Bakker'],
    },
    label,
    responses,
  });

  const html = renderReportHtml(model, artwork, chartColours(label.kleur));
  console.log(`  HTML: ${(html.length / 1024 / 1024).toFixed(2)} MB`);
  // Naast de PDF, zodat de opmaak ook in een browser te bekijken is.
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(out.replace(/\.pdf$/, '.html'), html, { encoding: 'utf8', mode: OWNER_ONLY });

  const renderStart = Date.now();
  const pdf = await createPdfRenderer().render(html);
  writeFileSync(out, pdf, { mode: OWNER_ONLY });
  console.log(
    `  PDF:  ${(pdf.byteLength / 1024 / 1024).toFixed(2)} MB in ${Date.now() - renderStart} ms\n` +
      `  → ${out}\n`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
