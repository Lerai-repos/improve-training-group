import { pasToe } from './apply';
import { knopFindings, mailFindings } from './findings';
import { withBoardLease } from './lease';
import { reconcile } from './reconcile';
import { rowForFinding } from './text';

import type { MailFailure } from '@lib/mail';
import type { KnopProbleem } from '@lib/report/knop-store';
import type { SignalGroupIds } from './groups';
import type { LeaseDeps } from './lease';
import type { ExistingSignal } from './reconcile';
import type { CheckFailure } from './run';
import type { Finding, FindingKind } from './types';
import type { SignalWriter } from './write';

/**
 * De snelle controle: alleen de twee evaluatiemeldingen, meteen na een druk op Eval Rapport.
 *
 * Zonder dit verschijnt "Eval Rapport niet gelukt" pas de volgende ochtend op het Systeem-bord,
 * terwijl Eval Status al `Zie Systeem-bord` zegt. Het is dezelfde verzoening als 's nachts
 * (`reconcile` + `pasToe`), beperkt tot `eval-knop` en `mail-mislukt`, en onder dezelfde
 * grendel, zodat er nog steeds één schrijver op het bord is.
 *
 * Wat hij bewust NIET doet, omdat het van de nachtelijke run is:
 * - de samenvatting "Laatste controle": die gaat over de volledige controle;
 * - foutrijen ("Controle kon niet draaien"): bij een storing in KV laat hij het bord met rust
 *   en meldt hij de storing alleen terug. 's Nachts wordt hij dan alsnog een foutrij.
 */

export interface EvaluatieSyncDeps {
  readonly readSignals: () => Promise<readonly ExistingSignal[]>;
  readonly readMailFailures: () => Promise<readonly MailFailure[]>;
  readonly readKnopProblemen: () => Promise<readonly KnopProbleem[]>;
  readonly writer: SignalWriter;
  readonly groups: SignalGroupIds;
  readonly now: () => Date;
}

export interface EvaluatieSyncReport {
  readonly findings: readonly Finding[];
  readonly created: number;
  readonly updated: number;
  readonly reopened: number;
  readonly resolved: number;
  readonly moved: number;
  /** Wat niet gelezen kon worden; die soorten zijn deze keer niet aangeraakt. */
  readonly failures: readonly CheckFailure[];
}

interface Deel {
  readonly check: string;
  readonly kinds: readonly FindingKind[];
  readonly lees: () => Promise<readonly Finding[]>;
}

export async function runEvaluatieSync(deps: EvaluatieSyncDeps): Promise<EvaluatieSyncReport> {
  const existing = await deps.readSignals();

  const delen: readonly Deel[] = [
    {
      check: 'mails',
      kinds: ['mail-mislukt'],
      lees: async () => mailFindings(await deps.readMailFailures()),
    },
    {
      check: 'evaluatieknop',
      kinds: ['eval-knop'],
      lees: async () => knopFindings(await deps.readKnopProblemen()),
    },
  ];

  const findings: Finding[] = [];
  const checked: FindingKind[] = [];
  const failures: CheckFailure[] = [];
  for (const deel of delen) {
    try {
      findings.push(...(await deel.lees()));
      checked.push(...deel.kinds);
    } catch (error) {
      failures.push({
        check: deel.check,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const actions = reconcile({ rows: findings.map(rowForFinding), existing, checked });
  const { applied, moved } = await pasToe(deps.writer, existing, actions, deps.groups);

  return {
    findings,
    created: applied.created,
    updated: applied.updated,
    reopened: applied.reopened,
    resolved: applied.resolved,
    moved,
    failures,
  };
}

export type EvaluatieSyncOutcome =
  | { readonly kind: 'ran'; readonly report: EvaluatieSyncReport }
  /** Een andere run had de grendel; de nachtelijke controle neemt het dan mee. */
  | { readonly kind: 'busy' }
  /** Te weinig tijd over in de route om nog een poging te wagen; ook dan doet de nacht het. */
  | { readonly kind: 'geen-tijd' };

/** Onder dezelfde grendel als de dagelijkse controle: één schrijver per bord. */
export async function runEvaluatieSyncExclusive(
  deps: EvaluatieSyncDeps,
  lease: LeaseDeps,
  boardId: string
): Promise<EvaluatieSyncOutcome> {
  const outcome = await withBoardLease(lease, boardId, () => runEvaluatieSync(deps));
  return outcome.kind === 'busy' ? { kind: 'busy' } : { kind: 'ran', report: outcome.value };
}

export interface GeduldOpties {
  readonly pogingen: number;
  readonly wachtMs: number;
  readonly slaap: (ms: number) => Promise<void>;
  /** Hoeveel tijd de route nog heeft; weglaten betekent onbegrensd (alleen in tests). */
  readonly tijdOverMs?: () => number;
}

/**
 * Wat één poging ruwweg kost: het Systeem-bord lezen, KV lezen en een paar schrijfacties.
 * Is er na het wachten minder over dan dit, dan heeft wachten geen zin meer.
 */
export const POGING_MS = 20_000;

/**
 * Een paar keer opnieuw bij een bezette grendel.
 *
 * Anders dan de nachtelijke run (die bij tegenstand gewoon overslaat, want de ander doet
 * hetzelfde werk) kan de ander hier KV al gelezen hebben vóór deze knopdruk zijn probleem
 * wegschreef. Overslaan zou die melding dan tot de volgende ochtend laten liggen.
 */
export async function metGeduld(
  run: () => Promise<EvaluatieSyncOutcome>,
  opties: GeduldOpties
): Promise<EvaluatieSyncOutcome> {
  const tijdOver = opties.tijdOverMs ?? (() => Number.POSITIVE_INFINITY);
  let uitkomst = await run();
  for (let poging = 1; poging < opties.pogingen && uitkomst.kind === 'busy'; poging += 1) {
    if (tijdOver() < opties.wachtMs + POGING_MS) {
      break;
    }
    await opties.slaap(opties.wachtMs);
    uitkomst = await run();
  }
  return uitkomst;
}
