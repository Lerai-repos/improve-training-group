'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';

import { grade } from '@components/recommendations/format';
import { TableCell, TableRow } from '@components/ui/table';
import { cn } from '@lib/utils';

import type { DisplayRow } from './sorting';

interface TrainerRowProps {
  readonly row: DisplayRow;
  readonly expanded: boolean;
  readonly onToggle: (trainerExternalId: string) => void;
  readonly themeNames: ReadonlyMap<string, string>;
}

/** Dutch decimals, and an em dash where there is nothing rather than a zero. */
const count = (value: number | null): string => (value === null ? '—' : String(value));

const COLUMN_COUNT = 5;

export const TrainerRow = ({ row, expanded, onToggle, themeNames }: TrainerRowProps) => {
  const handleToggle = () => {
    onToggle(row.trainerExternalId);
  };

  return (
    <>
      <TableRow data-testid="trainer-row">
        <TableCell className="font-medium">
          {/*
            A real button, not a clickable row.
            A `<tr>` takes no focus and answers no Enter or Space, so an onClick there is
            reachable with a mouse and by nobody else — and `aria-expanded` on a row
            announces a state without offering a control to change it. The button carries
            both the affordance and the state.
          */}
          <button
            type="button"
            onClick={handleToggle}
            aria-expanded={expanded}
            className="flex w-full items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {expanded ? (
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className={cn(row.unnamed && 'text-muted-foreground')}>{row.label}</span>
          </button>
        </TableCell>
        <TableCell className="text-right tabular-nums">{grade(row.overallAvg)}</TableCell>
        <TableCell className="text-right tabular-nums">{row.evaluationCount}</TableCell>
        <TableCell className="text-right tabular-nums">{count(row.trainingCount)}</TableCell>
        <TableCell className="text-right tabular-nums">{row.themeCount}</TableCell>
      </TableRow>

      {expanded && row.themes.length === 0 && (
        <TableRow>
          <TableCell colSpan={COLUMN_COUNT} className="pl-10 text-sm text-muted-foreground">
            Geen thema’s op deze trainer.
          </TableCell>
        </TableRow>
      )}

      {expanded &&
        row.themes.map((theme) => (
          <TableRow key={theme.themaExternalId} className="bg-muted/40" data-testid="theme-row">
            <TableCell className="pl-10 text-sm">
              {themeNames.get(theme.themaExternalId) ?? `#${theme.themaExternalId}`}
              <span className="ml-2 text-xs text-muted-foreground">{theme.qualification}</span>
            </TableCell>
            <TableCell className="text-right text-sm tabular-nums">
              {grade(theme.weightedAvg)}
            </TableCell>
            <TableCell className="text-right text-sm tabular-nums">
              {theme.evaluationCount}
            </TableCell>
            <TableCell className="text-right text-sm tabular-nums">{theme.timesTaught}</TableCell>
            <TableCell />
          </TableRow>
        ))}
    </>
  );
};
