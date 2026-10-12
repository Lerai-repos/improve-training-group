import { groupMoves, staleClosedByMarkers } from './move';
import { applyActions } from './write';

import type { SignalGroupIds } from './groups';
import type { ExistingSignal, SignalAction } from './reconcile';
import type { AppliedActions, SignalWriter } from './write';

/**
 * De acties op het bord zetten, en het bord daarna netjes achterlaten.
 *
 * Gedeeld door de nachtelijke controle en de snelle evaluatiecontrole, zodat die twee nooit
 * verschillend afvinken, heropenen of verplaatsen.
 *
 * **Verplaatsen NA het afvinken**, met de ids die deze run zelf afvinkte of heropende erbij.
 * `existing` is gelezen vóór de mutaties en staat dus nog op de oude toestand; zonder die ids
 * zou een melding die we net afvinkten pas bij de volgende run verhuizen.
 */
export async function pasToe(
  writer: SignalWriter,
  existing: readonly ExistingSignal[],
  actions: readonly SignalAction[],
  groups: SignalGroupIds,
  /** Iets dat tussen het toepassen en het verplaatsen hoort: de samenvatting van de nacht. */
  tussendoor: () => Promise<void> = async () => undefined
): Promise<{ readonly applied: AppliedActions; readonly moved: number }> {
  const applied = await applyActions(writer, actions, groups.open);
  await tussendoor();
  const moves = groupMoves({
    existing,
    resolvedIds: applied.resolvedIds,
    reopenedIds: applied.reopenedIds,
    groups,
  });
  for (const move of moves) {
    await writer.move(move);
  }
  for (const itemId of staleClosedByMarkers(existing, {
    reopenedIds: applied.reopenedIds,
    resolvedIds: applied.resolvedIds,
  })) {
    await writer.clearClosedBy(itemId);
  }
  return { applied, moved: moves.length };
}
