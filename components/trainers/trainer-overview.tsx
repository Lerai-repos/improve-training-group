'use client';

import { useMemo, useState } from 'react';

import { cn } from '@lib/utils';

import { Checkbox } from '@components/ui/checkbox';
import { Input } from '@components/ui/input';
import { Label } from '@components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@components/ui/table';

import { TRAINER_OVERVIEW_GROUPS } from '@lib/monday/board-config';

import { prepareRows, type OverviewSort, type SortKey } from './sorting';
import { SortableHeader } from './sortable-header';
import { TrainerRow } from './trainer-row';

import type { TrainerOverviewState } from './use-trainer-overview';

/**
 * Het trainer-overzicht: één rij per trainer, uitklapbaar naar de themarijen.
 *
 * Filter, sortering en welke rijen openstaan leven hier en nergens anders — ze overleven
 * een herlaadbeurt niet en dat hoeft ook niet. De gegevens komen uit de hook.
 */

interface TrainerOverviewProps {
  readonly state: TrainerOverviewState;
}

const COLUMNS: readonly { key: SortKey; label: string; numeric: boolean }[] = [
  { key: 'name', label: 'Trainer', numeric: false },
  { key: 'score', label: 'Cijfer', numeric: true },
  { key: 'evaluations', label: 'Evaluaties', numeric: true },
  { key: 'trainings', label: 'Trainingen', numeric: true },
  { key: 'themes', label: 'Thema’s', numeric: true },
];

/** Cijfer aflopend: bij een evaluatieronde is de eerste vraag wie eruit springt. */
const INITIAL_SORT: OverviewSort = { key: 'score', direction: 'desc' };

export const TrainerOverview = ({ state }: TrainerOverviewProps) => {
  const [onlyEvaluated, setOnlyEvaluated] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<OverviewSort>(INITIAL_SORT);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [allGroups, setAllGroups] = useState(false);

  /**
   * Which trainers the group scope allows, or null when there is no scope to apply.
   *
   * Null when the reader asked for every group; null once the board read has FAILED, since
   * a failed read must not empty the table; and null when the board came back with nothing,
   * because a scope built from an empty roster can only ever hide everything.
   *
   * Deliberately NOT null merely because the roster has not arrived yet — that case used to
   * be indistinguishable from the two above, which meant every group flashed on screen for
   * the moment before the board answered. It is handled by holding the table back instead.
   */
  const allowedTrainerIds = useMemo(() => {
    if (allGroups || state.rosterStatus === 'unavailable' || state.groupById.size === 0) {
      return null;
    }
    const wanted = new Set(TRAINER_OVERVIEW_GROUPS);
    return new Set(
      [...state.groupById.entries()]
        .filter(([, groupId]) => wanted.has(groupId))
        .map(([trainerId]) => trainerId)
    );
  }, [allGroups, state.groupById, state.rosterStatus]);

  const rows = useMemo(
    () =>
      prepareRows(
        state.payload?.trainers ?? [],
        state.names,
        { onlyEvaluated, search, allowedTrainerIds },
        sort,
        state.rosterIds
      ),
    [allowedTrainerIds, onlyEvaluated, search, sort, state.names, state.payload, state.rosterIds]
  );

  const handleToggleRow = (trainerExternalId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(trainerExternalId)) {
        next.add(trainerExternalId);
      }
      return next;
    });
  };

  const handleSearch = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(event.target.value);
  };

  const handleOnlyEvaluated = (checked: boolean | 'indeterminate') => {
    setOnlyEvaluated(checked === true);
  };

  const handleAllGroups = (checked: boolean | 'indeterminate') => {
    setAllGroups(checked === true);
  };

  /**
   * Nothing is painted until Monday has said which theme it is.
   *
   * This page lives in their iframe, over their canvas. Guessing light and correcting a
   * postMessage round trip later is a white flash in a dark workspace; guessing and being
   * *wrong forever* is worse. An empty transparent shell has nothing to be wrong about.
   *
   * A context FAILURE is not that moment — it never passes — so it falls through to the
   * light surface below, which is opaque and therefore legible on either canvas.
   */
  const themePending = state.theme === null && !state.themeUnavailable;

  /**
   * Monday's theme, scoped to THIS container.
   *
   * `monday-surface` re-points the shadcn tokens at Monday's own palette (#191B32 dark,
   * #FFFFFF light) — our own dark is near-black and reads as a hole punched in their
   * workspace. `darkMode: ['class']` matches an ancestor, so `dark` here themes
   * everything inside and nothing outside. Deliberately not `next-themes`: that
   * preference is shared across the origin and persisted, so setting it would rewrite the
   * user's theme in every other tab.
   */
  const surface = cn(
    'monday-surface flex min-h-screen flex-col gap-4 p-4 text-foreground',
    themePending ? 'bg-transparent' : 'bg-background',
    state.theme === 'dark' && 'dark'
  );

  if (themePending) {
    return <div className={surface} data-testid="theme-pending" />;
  }

  /**
   * The failure is reported FIRST, before any waiting.
   *
   * The roster comes from Monday and the payload from Redis, and neither waits for the
   * other. Checking the wait first meant a dead endpoint hid behind "Bezig met laden…"
   * for as long as the Monday request took — and forever if it hung.
   */
  if (state.status === 'error') {
    return (
      <div className={surface}>
        <p className="text-sm text-destructive">{state.error}</p>
      </div>
    );
  }

  /**
   * The roster counts as loading too.
   *
   * The overview payload is one Redis read; the roster needs the Monday context and then
   * a board query, so the payload effectively always wins. Rendering on it alone would
   * show every group — Inactief, Schaduwpool, the lot — for the moment before the board
   * answers and the table visibly shrinks under the reader.
   */
  if (state.status === 'loading' || state.rosterStatus === 'loading') {
    return (
      <div className={surface}>
        <p className="text-sm text-muted-foreground">Bezig met laden…</p>
      </div>
    );
  }

  return (
    <div className={surface}>
      <div className="flex flex-wrap items-center gap-4">
        <Input
          value={search}
          onChange={handleSearch}
          placeholder="Zoek een trainer"
          className="max-w-xs"
          aria-label="Zoek een trainer"
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id="alleen-met-evaluaties"
            checked={onlyEvaluated}
            onCheckedChange={handleOnlyEvaluated}
          />
          <Label htmlFor="alleen-met-evaluaties" className="text-sm font-normal">
            Alleen trainers met evaluaties
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="alle-groepen" checked={allGroups} onCheckedChange={handleAllGroups} />
          <Label htmlFor="alle-groepen" className="text-sm font-normal">
            Ook oud-trainers en overige groepen
          </Label>
        </div>
        <span className="text-sm text-muted-foreground">{rows.length} trainers</span>
      </div>

      {state.payload?.stale === true && (
        <p className="text-sm text-amber-600" role="status">
          Deze cijfers zijn van {state.payload.writtenAt?.slice(0, 10)} — de nachtelijke
          berekening loopt achter.
        </p>
      )}

      {state.nameWarning !== null && (
        <p className="text-sm text-muted-foreground" role="status">
          {state.nameWarning}
        </p>
      )}

      {/*
        A FIXED layout, and that is the point rather than a detail.
        With the default `auto`, unfolding a trainer widens the first column — theme names
        are longer than trainer names and carry a qualification label — and every numeric
        column jumps sideways at the moment the reader is looking at them. Fixed widths
        mean opening a row cannot move anything that was already on screen.
      */}
      <Table className="table-fixed">
        <colgroup>
          <col />
          <col className="w-32" />
          <col className="w-32" />
          <col className="w-32" />
          <col className="w-28" />
        </colgroup>
        <TableHeader>
          <TableRow>
            {COLUMNS.map((column) => (
              <SortableHeader
                key={column.key}
                column={column}
                sort={sort}
                onSort={setSort}
              />
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={COLUMNS.length} className="h-24 text-center">
                {state.payload?.writtenAt === null
                  ? 'De nachtelijke berekening heeft nog niet gedraaid.'
                  : 'Geen trainers die aan dit filter voldoen.'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TrainerRow
                key={row.trainerExternalId}
                row={row}
                expanded={expanded.has(row.trainerExternalId)}
                onToggle={handleToggleRow}
                themeNames={state.themeNames}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
};
