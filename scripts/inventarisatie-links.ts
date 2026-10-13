/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { buildInventarisatieDeps, syncAlleLinks } from '@lib/inventarisatie';

/**
 * De link naar het inventarisatieformulier op elke bestaande Opportunity.
 *
 *   pnpm inventarisatie:links            # droogloop: hoeveel er geschreven en gewist zouden worden
 *   pnpm inventarisatie:links --apply    # echt schrijven
 *
 * Eenmalig voor wat er al staat; daarna houden de webhook en de nachtelijke ronde het bij. Schrijft
 * alleen verschillen, dus opnieuw draaien is onschuldig. Ruim duizend Opportunities: reken bij de
 * eerste keer op een paar minuten.
 */

const EXIT_FAILURE = 1;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const started = Date.now();
  const rapport = await syncAlleLinks(buildInventarisatieDeps({ dryRun: !apply }));

  console.log(`\nInventarisatielinks — ${apply ? 'APPLY' : 'droogloop'}\n`);
  console.log(`  Opportunities gelezen:   ${rapport.opportunities}`);
  console.log(`  ${apply ? 'geschreven' : 'zou schrijven'}:          ${rapport.geschreven}`);
  console.log(`  ${apply ? 'gewist' : 'zou wissen'}:              ${rapport.gewist}`);
  console.log(`  klopte al / geen link:   ${rapport.ongewijzigd}`);
  if (rapport.mislukt.length > 0) {
    console.log(`  MISLUKT:                 ${rapport.mislukt.length}`);
    for (const m of rapport.mislukt.slice(0, 10)) {
      console.log(`     ${m.itemId}: ${m.fout}`);
    }
  }
  console.log(`  (${Math.round((Date.now() - started) / 1000)} s)\n`);
  if (!apply) {
    console.log('  Droogloop. Voer uit met --apply om het echt weg te schrijven.\n');
  }
  if (rapport.mislukt.length > 0) {
    process.exit(EXIT_FAILURE);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(EXIT_FAILURE);
});
