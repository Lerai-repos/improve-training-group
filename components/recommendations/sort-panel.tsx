'use client';

import { ArrowDown, ArrowUp, ChevronDown, Plus, RotateCcw, X } from 'lucide-react';

import { Button } from '@components/ui/button';
import { cn } from '@lib/utils';

import {
  addLevel,
  defaultDirection,
  labelOf,
  moveLevel,
  removeLevel,
  setDirection,
  sortColumnsFor,
  type SortDirection,
  type SortKey,
  type SortLevel,
} from './sorting';

/**
 * The Sort panel, shaped like the Airtable interface it replaces.
 *
 * Priority is explicit and reorderable rather than implied by the order someone happened
 * to click headers in: the first row is the primary sort, and each row below breaks the
 * ties above it. Any number of levels, because the team is used to that and there is no
 * principled place to stop them.
 *
 * Directions read `laag → hoog` / `hoog → laag` rather than an arrow alone. "Ascending"
 * on a money column and on a grade column mean opposite things to a planner, and the
 * words say which without them having to work it out.
 */

const DIRECTION_LABELS: Record<SortDirection, string> = {
  asc: 'laag → hoog',
  desc: 'hoog → laag',
};

interface SortPanelProps {
  sort: readonly SortLevel[];
  onChange: (levels: SortLevel[]) => void;
  canViewFull: boolean;
  /** Must return focus to the trigger — see the note on dismissal below. */
  onClose: () => void;
}

export const SortPanel = ({ sort, onChange, canViewFull, onClose }: SortPanelProps) => {
  const columns = sortColumnsFor(canViewFull);
  const used = new Set(sort.map((level) => level.key));
  const available = columns.filter((column) => !used.has(column.key));

  /**
   * Escape dismisses, and closing always hands focus back to the trigger.
   *
   * Both matter for the same reason: removing the last row, or pressing Sluiten,
   * unmounts the element that had focus — and the browser then drops focus to
   * `document.body`, stranding a keyboard user at the top of the page with no way back
   * to where they were. `onClose` is responsible for the focus half; this handles the key.
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Sorteren"
      onKeyDown={handleKeyDown}
      className="absolute right-0 top-10 z-20 w-[26rem] rounded-md border border-border bg-card p-3 shadow-lg"
    >
      {sort.length === 0 ? (
        <p className="px-1 pb-2 text-sm text-muted-foreground">
          Nog geen sortering — kies hieronder een kolom.
        </p>
      ) : (
        <ol className="flex flex-col gap-2 pb-2">
          {sort.map((level, index) => (
            <SortRow
              key={level.key}
              level={level}
              index={index}
              total={sort.length}
              onChange={onChange}
              sort={sort}
            />
          ))}
        </ol>
      )}

      {available.length > 0 && (
        <div className="max-h-56 overflow-y-auto border-t border-border pt-2">
          {available.map((column) => (
            <AddRow key={column.key} column={column} sort={sort} onChange={onChange} />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange([]);
          }}
          disabled={sort.length === 0}
        >
          <RotateCcw className="mr-2 size-3" />
          Reset
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Sluiten
        </Button>
      </div>
    </div>
  );
};

interface SortRowProps {
  level: SortLevel;
  index: number;
  total: number;
  sort: readonly SortLevel[];
  onChange: (levels: SortLevel[]) => void;
}

const SortRow = ({ level, index, total, sort, onChange }: SortRowProps) => {
  const handleDirection = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    onChange(setDirection(sort, level.key, event.target.value === 'desc' ? 'desc' : 'asc'));
  };
  const handleRemove = (): void => {
    onChange(removeLevel(sort, level.key));
  };
  const handleUp = (): void => {
    onChange(moveLevel(sort, level.key, -1));
  };
  const handleDown = (): void => {
    onChange(moveLevel(sort, level.key, 1));
  };

  return (
    <li className="flex items-center gap-2">
      <span className="w-4 text-right text-xs tabular-nums text-muted-foreground">{index + 1}</span>
      <span className="flex-1 truncate text-sm">{labelOf(level.key)}</span>

      <select
        value={level.direction}
        onChange={handleDirection}
        aria-label={`Richting voor ${labelOf(level.key)}`}
        className="rounded border border-input bg-background px-2 py-1 text-xs"
      >
        <option value="asc">{DIRECTION_LABELS.asc}</option>
        <option value="desc">{DIRECTION_LABELS.desc}</option>
      </select>

      {/* Buttons rather than drag: reordering has to work from a keyboard, and two
          arrows do the same job as a drag handle without the pointer choreography. */}
      <button
        type="button"
        onClick={handleUp}
        disabled={index === 0}
        aria-label={`${labelOf(level.key)} belangrijker maken`}
        className="text-muted-foreground disabled:opacity-30"
      >
        <ArrowUp className="size-3" />
      </button>
      <button
        type="button"
        onClick={handleDown}
        disabled={index === total - 1}
        aria-label={`${labelOf(level.key)} minder belangrijk maken`}
        className="text-muted-foreground disabled:opacity-30"
      >
        <ArrowDown className="size-3" />
      </button>
      <button
        type="button"
        onClick={handleRemove}
        aria-label={`${labelOf(level.key)} verwijderen`}
        className="text-muted-foreground hover:text-destructive"
      >
        <X className="size-3.5" />
      </button>
    </li>
  );
};

const AddRow = ({
  column,
  sort,
  onChange,
}: {
  column: { key: SortKey; label: string };
  sort: readonly SortLevel[];
  onChange: (levels: SortLevel[]) => void;
}) => {
  const handleAdd = (): void => {
    onChange(addLevel(sort, column.key));
  };

  return (
    <button
      type="button"
      onClick={handleAdd}
      className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left text-sm hover:bg-accent"
    >
      <Plus className="size-3 text-muted-foreground" />
      {column.label}
      <span className="ml-auto text-xs text-muted-foreground">
        {DIRECTION_LABELS[defaultDirection(column.key)]}
      </span>
    </button>
  );
};

/** The button that opens the panel, carrying the level count like Airtable's. */
export const SortButton = ({
  count,
  open,
  onToggle,
  buttonRef,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  /** Held by the parent so closing the panel can put focus back here. */
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}) => (
  <Button ref={buttonRef} variant="outline" size="sm" onClick={onToggle} aria-expanded={open}>
    Sorteren
    {count > 0 && (
      <span className="ml-2 rounded bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
        {count}
      </span>
    )}
    <ChevronDown className={cn('ml-1 size-3 transition-transform', open && 'rotate-180')} />
  </Button>
);
