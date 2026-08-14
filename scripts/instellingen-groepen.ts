/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { MONDAY_API_VERSION, TRAINERS_BOARD } from '@lib/monday/board-config';
import { createMondayGraphQLClient } from '@lib/monday/graphql-client';
import { createMondayMutationClient } from '@lib/monday/mutate';
import {
  groepenKeyPrefix,
  loadSettingsOnce,
  priceableGroups,
  provisionGroepselectie,
  resolveSettingsBoard,
} from '@lib/settings';

/**
 * Put the `Groepen` dropdown and the `TRAINERGROEPEN` row on the Instellingen board.
 *
 *   pnpm instellingen:groepen              # dry run — prints what it would do
 *   pnpm instellingen:groepen --apply
 *
 * This is the fase-2a cutover: from the moment the row exists, the BOARD decides which
 * trainer groups may be recommended from, and `RECOMMENDABLE_TRAINER_GROUPS` stops being
 * consulted.
 *
 * ## Run it only on a deployment that tolerates the row
 *
 * Code from before this feature reads the row's blank `Waarde` as a *present* empty
 * value, which suppresses the environment fallback and fails the schema — so every
 * training it touches ends in FOUT. Deploy the tolerant reader first, then wait out the
 * worker's full 300 s `maxDuration` so nothing older is still running, and only then
 * apply. Rolling back afterwards means deleting this row FIRST.
 *
 * ## The seed is what is EFFECTIVE, not what the code defaults to
 *
 * `recommendableGroups()` returns the `GROUP_POLICY` default, while the live selection
 * may be overridden. Seeding from the helper would silently change who is eligible on
 * exactly the run that was meant to change only where the value comes from — so the
 * current configuration is read first and persisted verbatim.
 */

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes('--apply');

  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error('Missing MONDAY_API_TOKEN (.env.local)');
  }

  const read = createMondayGraphQLClient({ token, apiVersion: MONDAY_API_VERSION });
  const write = createMondayMutationClient({ token, apiVersion: MONDAY_API_VERSION });
  const board = resolveSettingsBoard();

  console.log(apply ? 'APPLY — writing to Monday\n' : 'DRY RUN — nothing is written\n');
  console.log(`Instellingen-board: ${board.boardId}`);

  // The EFFECTIVE selection, through the same path the engine uses.
  const before = await loadSettingsOnce(read);
  const selection = before.app.recommendableTrainerGroups;
  console.log(`Huidige selectie:   ${selection.join(', ')}`);
  console.log(`Fingerprint vooraf: ${before.fingerprint.slice(0, 12)}`);

  const priceable = priceableGroups();
  const unpriceable = selection.filter((g) => !priceable.includes(g));
  if (unpriceable.length > 0) {
    // Narrowing it silently would be a change of eligibility disguised as a migration.
    throw new Error(
      `De huidige selectie bevat groep(en) zonder tarief: ${unpriceable.join(', ')}. ` +
        'Trainers daaruit worden altijd overgeslagen. Corrigeer de configuratie eerst; ' +
        'dit script past de selectie niet zelf aan.'
    );
  }

  // Titles are the human half of each label only; identity is the option id.
  const [trainers] = await read.getSchema([TRAINERS_BOARD]);
  const titles = new Map((trainers?.groups ?? []).map((g) => [g.id, g.title]));

  const result = await provisionGroepselectie({
    read,
    write,
    boardId: board.boardId,
    notitiesGroupId: board.notitiesGroupId,
    keyPrefix: groepenKeyPrefix(board.boardId),
    apply,
    selection,
    titles,
    log: (line) => console.log(`  ${line}`),
  });

  if (!apply) {
    console.log('\nDry run klaar. Draai opnieuw met --apply om dit echt te doen.');
    return;
  }

  /**
   * The migration's proof: the same values from a different source hash identically.
   *
   * Read through the pinned map that was just discovered, because the constant in the
   * code cannot contain it yet — that is the next step, by hand.
   */
  const after = await loadSettingsOnce(read, {
    pinned: { ...board, groepenOptions: result.optionMap },
  });
  console.log(`\nFingerprint achteraf: ${after.fingerprint.slice(0, 12)}`);
  if (after.fingerprint !== before.fingerprint) {
    throw new Error(
      'De fingerprint is veranderd. Er is dus meer gewijzigd dan alleen de bron van de ' +
        `selectie: ${before.app.recommendableTrainerGroups.join(', ')} → ` +
        `${after.app.recommendableTrainerGroups.join(', ')}. Niet doorzetten naar de ` +
        'strikte deploy voordat dit klopt.'
    );
  }
  console.log('✓ ongewijzigd — alleen de bron van de selectie is verplaatst');

  const options = [...result.optionMap.entries()].map(([id, group]) => `${id}=${group}`).join(',');
  console.log('\n── Vast te leggen in lib/settings/board.ts ──');
  console.log('  groepenOptions: new Map([');
  for (const [id, group] of result.optionMap) {
    console.log(`    ['${id}', '${group}'],`);
  }
  console.log('  ]),');
  console.log(`\n── Of, voor een preview-board ──\n  MONDAY_INSTELLINGEN_GROEPEN_OPTIONS=${options}`);
  console.log(
    '\nMonday genereert deze optie-ids per board, dus een preview-board heeft andere. ' +
      'Zonder vastlegging leidt de reader de identiteit af uit de labelteksten; ' +
      'daarna is het label alleen nog opmaak.'
  );
}

main().catch((error: unknown) => {
  console.error('\ninstellingen:groepen failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
