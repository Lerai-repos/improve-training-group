'use client';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@components/ui/alert-dialog';

import type { PickMode } from './pick-trainer';

/**
 * "There is already a trainer on this training — did you mean to add, or to swap?"
 *
 * The relation write replaces the column's whole list, and **80 of the 756 trainings on
 * Agenda 2026 have two or more trainers**. So a bare "Kies" carried two incompatible
 * intentions, and picked the destructive one every time: the planner adding a second
 * trainer silently removed the first, with no warning and nothing to undo it.
 *
 * Both intentions are legitimate, and nothing on screen distinguishes them — which is
 * exactly the case for asking rather than guessing. The question is only posed when it is
 * real: with an empty relation, Kies still links in one click.
 *
 * **Toevoegen is the confirming action; Vervangen is marked destructive.** Only one of the
 * two can lose work, and if a planner dismisses this dialog on autopilot the safe branch
 * is the one that should be under their thumb.
 *
 * ## Vervangen raakt alleen de leadtrainer
 *
 * Sinds de kolomsplitsing van 21-Aug-2026 schrijft `replace` naar de leadkolom en blijven
 * `itg_cotrainers` staan. De tekst zei tot 24-Aug *"de huidige koppelingen vervangen"* en
 * noemde de co-trainers bij naam in dezelfde zin — een belofte die de knop niet waarmaakte.
 *
 * Het alternatief was de co-trainers meewissen. Dat is bewust niet gedaan: dat zou een
 * **nieuwe** vernietigende schrijfactie zijn die niemand heeft gevraagd, op een knop die is
 * bedacht toen er nog één kolom en één rol was. Een planner die van lead wisselt bedoelt
 * bijna altijd "verkeerde lead", niet "gooi de hele bezetting weg".
 *
 * Gevolg, en het staat er met opzet niet als knop: een co-trainer verwijderen kan hier niet.
 * Dat gebeurt op het bord in Monday.
 */

export interface PendingPick {
  trainerItemId: string;
  /** Resolved name, or null when the roster lookup failed — never a silent blank. */
  name: string | null;
}

interface PickConfirmDialogProps {
  /** The pick awaiting an answer, or null when the dialog is closed. */
  pending: PendingPick | null;
  /** Everyone currently on the relation, already resolved to names where possible. */
  linkedLabels: readonly string[];
  onDecide: (trainerItemId: string, mode: PickMode) => void;
  onCancel: () => void;
}

export const PickConfirmDialog = ({
  pending,
  linkedLabels,
  onDecide,
  onCancel,
}: PickConfirmDialogProps) => {
  const handleOpenChange = (open: boolean): void => {
    // Escape, the overlay and the Cancel button all arrive here. Closing without a choice
    // must never fall through to a write.
    if (!open) {
      onCancel();
    }
  };

  const handleAppend = (): void => {
    if (pending !== null) {
      onDecide(pending.trainerItemId, 'append');
    }
  };

  const handleReplace = (): void => {
    if (pending !== null) {
      onDecide(pending.trainerItemId, 'replace');
    }
  };

  const chosen = pending === null ? '' : (pending.name ?? `#${pending.trainerItemId}`);
  const plural = linkedLabels.length > 1;

  return (
    <AlertDialog open={pending !== null} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {plural ? 'Er zijn al trainers gekoppeld' : 'Er is al een trainer gekoppeld'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Aan deze training {plural ? 'zijn' : 'is'} al gekoppeld:{' '}
            <strong>{linkedLabels.join(', ')}</strong>. Wil je <strong>{chosen}</strong> daarnaast
            koppelen, of de leadtrainer vervangen? Co-trainers blijven in beide gevallen staan;
            die haal je weg op het bord.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Annuleren</AlertDialogCancel>
          {/* Destructive styling on the only branch that can lose a colleague's work. */}
          <AlertDialogAction
            onClick={handleReplace}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Leadtrainer vervangen
          </AlertDialogAction>
          <AlertDialogAction onClick={handleAppend}>Toevoegen</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
