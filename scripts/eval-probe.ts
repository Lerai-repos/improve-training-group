/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import {
  attributeResponses,
  createOAuthGoogleAuth,
  evaluationDocuments,
  googleSheetsSource,
  oauthCredentialsFromEnv,
} from '@lib/evaluations';

/**
 * Read the real sheets and report what came back. No writes, no Monday, no Redis.
 *
 * This is the first thing to run once the refresh token exists: it proves the whole
 * read path — token exchange, per-document access, header resolution, row decoding —
 * and prints the resolved column indexes, which is how a renamed question shows up as a
 * line of output instead of a silently empty nightly run.
 *
 *   doppler run -c prd -- pnpm eval:probe
 */

function main(): Promise<void> {
  const credentials = oauthCredentialsFromEnv();
  const documents = evaluationDocuments();
  const source = googleSheetsSource(createOAuthGoogleAuth(credentials), documents);

  console.log(`\nLezen: ${documents.documents.map((d) => d.label).join(', ')}\n`);

  return source.readResponses().then(({ responses, sheets }) => {
    for (const sheet of sheets) {
      console.log(`── ${sheet.source.label}  (${sheet.source.sheetName})`);
      console.log(`   rijen        ${sheet.totalRows} (${sheet.blankRows} leeg)`);
      console.log(`   reacties     ${sheet.responses}`);
      console.log(`   kolommen     code=${sheet.columns.code} cijfer=${sheet.columns.grade} tijd=${sheet.columns.timestamp ?? '—'}`);
      if (sheet.blankCodeRows > 0) {
        console.log(`   zonder code  ${sheet.blankCodeRows}`);
      }
      if (sheet.anomalies.length > 0) {
        console.log(`   anomalieën   ${sheet.anomalies.length} (eerste: rij ${sheet.anomalies[0].rowNumber}, "${sheet.anomalies[0].raw}")`);
      }
      console.log('');
    }

    const graded = responses.filter((r) => r.grade !== null).length;
    console.log(`Totaal: ${responses.length} reacties, ${graded} met cijfer, ${responses.length - graded} zonder.`);

    // No training list here on purpose — this probe must not need Monday. The join is
    // exercised by `pnpm eval:dryrun` once the stats board exists.
    const { report } = attributeResponses(responses, []);
    console.log(
      `Zonder trainingen om tegen te matchen belanden ze allemaal in de verliesboekhouding: ` +
        `${report.losses.length} buckets. Dat hoort zo — dit is een leescontrole.\n`
    );
  });
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
