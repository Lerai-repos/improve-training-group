'use client';

import { Check, Loader2 } from 'lucide-react';

import { Button } from '@components/ui/button';
import { Checkbox } from '@components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@components/ui/table';
import { cn } from '@lib/utils';

import { duration, euros, grade } from './format';

import type { Row } from './types';

/**
 * The ranked list.
 *
 * **Two column sets, chosen by capability.** A `full` caller sees the money and sorts by
 * total cost — the spec's *"Totale kosten = de sorteerkolom"*. A restricted caller has no
 * money at all in their payload, so there is nothing to sort by but `rank`, and the
 * header says so rather than implying a hidden column exists.
 *
 * Sorting is client-side over an already-complete list: it is at most a few dozen rows,
 * and a round trip to reorder them would be slower and could return a different
 * generation.
 */

export type SortKey = 'rank' | 'totalCostCents' | 'roundTripDurationMinutes' | 'grade';

interface RecommendationTableProps {
  rows: Row[];
  names: ReadonlyMap<string, string>;
  canViewFull: boolean;
  canPlan: boolean;
  sortKey: SortKey;
  onSort: (key: SortKey) => void;
  onApproachedChange: (trainerItemId: string, approached: boolean) => void;
  /** Link this trainer to the training. Written client-side, as the planner. */
  onPick: (trainerItemId: string) => void;
  /** The trainer being linked right now, so only that row spins. */
  picking: string | null;
  /**
   * Trainers already linked on the Monday item — read from Monday, not from our API,
   * which knows nothing about a relation it never wrote.
   */
  linkedTrainerIds: readonly string[];
  /**
   * False while the relation is unknown or unreadable. Picking then is refused, because
   * "we could not find out who is linked" must not behave like "nobody is linked".
   */
  canPick: boolean;
  /** Any generation-sensitive action is in flight; every control freezes. */
  busy: boolean;
  /** Set while the list is known to be superseded — the controls are frozen. */
  stale: boolean;
}

function sortValue(row: Row, key: SortKey): number {
  switch (key) {
    case 'totalCostCents':
      return row.totalCostCents ?? Number.POSITIVE_INFINITY;
    case 'roundTripDurationMinutes':
      return row.roundTripDurationMinutes;
    case 'grade':
      // No grades sorts LAST rather than as a zero: "unknown" is not "worst".
      return -(row.overallAverageDisplay ?? Number.NEGATIVE_INFINITY);
    default:
      return row.rank;
  }
}

export const RecommendationTable = ({
  rows,
  names,
  canViewFull,
  canPlan,
  sortKey,
  onSort,
  onApproachedChange,
  onPick,
  picking,
  linkedTrainerIds,
  canPick,
  busy,
  stale,
}: RecommendationTableProps) => {
  const sorted = [...rows].sort((a, b) => sortValue(a, sortKey) - sortValue(b, sortKey));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableHead sortKey="rank" active={sortKey} onSort={onSort}>
            #
          </SortableHead>
          <TableHead>Trainer</TableHead>
          {canViewFull && (
            <SortableHead sortKey="grade" active={sortKey} onSort={onSort}>
              Cijfer
            </SortableHead>
          )}
          <SortableHead sortKey="roundTripDurationMinutes" active={sortKey} onSort={onSort}>
            Reistijd (retour)
          </SortableHead>
          {canViewFull && (
            <>
              <TableHead className="text-right">Uurtarief</TableHead>
              <TableHead className="text-right">Reiskosten</TableHead>
              <SortableHead sortKey="totalCostCents" active={sortKey} onSort={onSort} align="right">
                Totale kosten
              </SortableHead>
            </>
          )}
          <TableHead className="text-center">Benaderd</TableHead>
          {canPlan && <TableHead />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((row) => (
          <TrainerRow
            key={row.trainerItemId}
            row={row}
            name={names.get(row.trainerItemId) ?? null}
            canViewFull={canViewFull}
            canPlan={canPlan}
            onApproachedChange={onApproachedChange}
            onPick={onPick}
            picking={picking}
            linked={linkedTrainerIds.includes(row.trainerItemId)}
            canPick={canPick}
            busy={busy}
            stale={stale}
          />
        ))}
      </TableBody>
    </Table>
  );
};

interface SortableHeadProps {
  sortKey: SortKey;
  active: SortKey;
  onSort: (key: SortKey) => void;
  align?: 'right';
  children: React.ReactNode;
}

const SortableHead = ({ sortKey, active, onSort, align, children }: SortableHeadProps) => {
  const handleClick = (): void => {
    onSort(sortKey);
  };

  // `aria-sort` belongs on the column header, not on the control inside it: the button
  // role does not support the attribute, so a screen reader would ignore it there.
  return (
    <TableHead
      aria-sort={active === sortKey ? 'ascending' : 'none'}
      className={cn(align === 'right' && 'text-right')}
    >
      <button
        type="button"
        onClick={handleClick}
        className={cn('hover:underline', active === sortKey && 'font-semibold text-primary')}
      >
        {children}
      </button>
    </TableHead>
  );
};

interface TrainerRowProps {
  row: Row;
  name: string | null;
  canViewFull: boolean;
  canPlan: boolean;
  onApproachedChange: (trainerItemId: string, approached: boolean) => void;
  onPick: (trainerItemId: string) => void;
  picking: string | null;
  linked: boolean;
  canPick: boolean;
  busy: boolean;
  stale: boolean;
}

const TrainerRow = ({
  row,
  name,
  canViewFull,
  canPlan,
  onApproachedChange,
  onPick,
  picking,
  linked,
  canPick,
  busy,
  stale,
}: TrainerRowProps) => {
  const handleApproached = (checked: boolean | 'indeterminate'): void => {
    onApproachedChange(row.trainerItemId, checked === true);
  };

  const handlePick = (): void => {
    onPick(row.trainerItemId);
  };

  const isPicking = picking === row.trainerItemId;

  return (
    <TableRow
      className={cn(row.approached && 'text-muted-foreground', linked && 'bg-primary-lighter')}
    >
      <TableCell>{row.rank}</TableCell>
      <TableCell>
        <span className="flex items-center gap-2">
          {/* An id is an honest fallback: the list is still ranked and still correct. */}
          {name ?? <span className="text-muted-foreground">#{row.trainerItemId}</span>}
          {linked && (
            <span
              className="flex items-center gap-1 text-xs font-medium text-primary"
              title="Deze trainer is aan de training gekoppeld"
            >
              <Check className="size-3" />
              Gekoppeld
            </span>
          )}
        </span>
      </TableCell>
      {canViewFull && (
        <TableCell
          className={cn(row.overallAverageDisplay === null && 'text-muted-foreground italic')}
        >
          {grade(row.overallAverageDisplay)}
        </TableCell>
      )}
      <TableCell>{duration(row.roundTripDurationMinutes)}</TableCell>
      {canViewFull && (
        <>
          <TableCell className="text-right">{euros(row.hourlyRateCents)}</TableCell>
          <TableCell className="text-right">{euros(row.trainerTravelCostCents)}</TableCell>
          <TableCell className="text-right font-medium">{euros(row.totalCostCents)}</TableCell>
        </>
      )}
      <TableCell className="text-center">
        <Checkbox
          checked={row.approached}
          disabled={!canPlan || stale || busy}
          onCheckedChange={handleApproached}
          aria-label={`Benaderd: ${name ?? row.trainerItemId}`}
        />
      </TableCell>
      {canPlan && (
        <TableCell className="text-right">
          {/* Shown on `canPlan`, but that is presentation only: the write happens
              client-side as the logged-in user, so Monday's own column permission is
              what actually decides whether it lands. */}
          <Button
            size="sm"
            variant={linked ? 'ghost' : 'secondary'}
            onClick={handlePick}
            // `busy` covers a recalculate running alongside: it can advance the
            // generation between a pick's before- and after-checks, so both pass while
            // the trainer came from the superseded list.
            disabled={stale || busy || linked || !canPick}
            aria-label={`Kies ${name ?? row.trainerItemId}`}
          >
            {isPicking && <Loader2 className="mr-2 size-4 animate-spin" />}
            {linked ? 'Gekozen' : 'Kies'}
          </Button>
        </TableCell>
      )}
    </TableRow>
  );
};
