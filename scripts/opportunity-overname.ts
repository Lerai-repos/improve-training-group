/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { buildOvernameDeps, runOvername } from '@lib/overname';

/**
 * De overname uit de Opportunity met de hand draaien. Zelfde aansluitingen als de cron.
 *
 *   pnpm opportunity:overname           # droogloop — leest alles, schrijft niets
 *   pnpm opportunity:overname --apply
 *   pnpm opportunity:overname --apply --item <itemId>   # alleen die ene training
 */

const EXIT_FAILURE = 1;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const itemIndex = process.argv.indexOf('--item');
  const item = itemIndex === -1 ? undefined : process.argv[itemIndex + 1];
  if (itemIndex !== -1 && (item === undefined || item.startsWith('--'))) {
    throw new Error('--item vraagt om een item-id.');
  }

  const deps = buildOvernameDeps({ dryRun: !apply });
  /** Met `--item` alleen die ene training: om de job op één rij te proberen vóór de hele agenda. */
  const report = await runOvername(
    item === undefined
      ? deps
      : {
          ...deps,
          readKandidaten: async (board) =>
            (await deps.readKandidaten(board)).filter((rij) => rij.itemId === item),
        }
  );

  console.log(
    `${report.dryRun ? 'DROOGLOOP' : 'UITGEVOERD'} — borden: ${report.borden.join(', ') || 'geen'}`
  );
  console.log(
    `${report.trainingen} komende trainingen met Opportunity, ${report.metAntwoord} met een antwoord.`
  );
  console.log(`\n${report.dryRun ? 'Zou schrijven' : 'Geschreven'}: ${report.geschreven.length}`);
  for (const g of report.geschreven) {
    console.log(`  ${g.itemId} ${g.naam.slice(0, 40).padEnd(40)} ${JSON.stringify(g.waarden)}`);
  }
  console.log(`\nConflicten (niet geschreven): ${report.conflicten.length}`);
  for (const c of report.conflicten) {
    const regels = c.conflicten.map(
      (x) => `${x.veld}: Opportunity ${x.opportunity} / agenda ${x.agenda}`
    );
    console.log(`  ${c.itemId} ${c.naam.slice(0, 40).padEnd(40)} ${regels.join('; ')}`);
  }
  if (report.mislukt.length > 0) {
    console.log(`\nMISLUKT: ${report.mislukt.length}`);
    for (const m of report.mislukt) {
      console.log(`  ${m.bord}${m.training === undefined ? '' : ` ${m.training}`}: ${m.fout}`);
    }
    process.exit(EXIT_FAILURE);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
