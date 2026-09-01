'use client';

import { ChevronRight } from 'lucide-react';

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

/**
 * Per-row delay on the unfold, in milliseconds.
 *
 * A stagger reads as the block arriving rather than blinking into existence.
 */
const STAGGER_MS = 20;

/**
 * How many rows the stagger applies to before it stops growing.
 *
 * `fill-mode-backwards` holds a row invisible until ITS delay expires, so an uncapped
 * stagger is a hidden row for as long as the delay. That is fine for a handful and
 * absurd for a real one: `docs/m2b/README.md` records trainers with about 95 themes
 * apiece, which uncapped would leave the last row blank for nearly two seconds.
 *
 * Capped, the whole block is on screen within 160 ms however long it is — still enough
 * offset for the first rows to read as arriving in sequence, which is the entire point
 * of the effect.
 */
const MAX_STAGGERED_ROWS = 8;

export const TrainerRow = ({ row, expanded, onToggle, themeNames }: TrainerRowProps) => {
  const handleToggle = () => {
    onToggle(row.trainerExternalId);
  };

  /**
   * The whole row is clickable, and the button inside it still works.
   *
   * Without `stopPropagation` the button's click would bubble to the row and toggle a
   * second time, which is an unfold that instantly folds again — the classic
   * nested-control bug. The button keeps its own handler rather than deferring to the
   * row, because it is what makes this reachable by keyboard at all.
   */
  const handleButton = (event: React.MouseEvent) => {
    event.stopPropagation();
    handleToggle();
  };

  /**
   * Ignore a click that ends a text selection.
   *
   * With a clickable row, dragging across a trainer's name to copy it would otherwise
   * collapse the row the moment the mouse comes up.
   */
  const handleRow = () => {
    if ((window.getSelection()?.toString() ?? '') !== '') {
      return;
    }
    handleToggle();
  };

  return (
    <>
      <TableRow onClick={handleRow} className="cursor-pointer" data-testid="trainer-row">
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
            onClick={handleButton}
            aria-expanded={expanded}
            className="flex w-full items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {/* One chevron that turns, rather than two that swap: the rotation is the
                same gesture as the unfold, and swapping icons cannot be animated. */}
            <ChevronRight
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
                expanded && 'rotate-90'
              )}
            />
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
        row.themes.map((theme, index) => (
          <TableRow
            key={theme.themaExternalId}
            /**
             * Faded and nudged into place rather than appearing outright.
             *
             * A table row cannot be height-animated — the layout algorithm owns that — so
             * the movement lives in opacity and a one-step slide, which needs no knowledge
             * of how tall the block will be. `motion-reduce` switches it off entirely.
             */
            className="animate-in fade-in-0 slide-in-from-top-1 bg-muted/40 duration-200 fill-mode-backwards motion-reduce:animate-none"
            style={{ animationDelay: `${Math.min(index, MAX_STAGGERED_ROWS) * STAGGER_MS}ms` }}
            data-testid="theme-row"
          >
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
