'use client';

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';

import { Button } from '@components/ui/button';
import { TableHead } from '@components/ui/table';
import { cn } from '@lib/utils';

import type { OverviewSort, SortKey } from './sorting';

interface SortableHeaderProps {
  readonly column: { key: SortKey; label: string; numeric: boolean };
  readonly sort: OverviewSort;
  readonly onSort: (sort: OverviewSort) => void;
}

/**
 * Eén kolomkop.
 *
 * Een eigen component omdat de klikafhandelaar de kolom nodig heeft: een inline pijlfunctie
 * in de `map` hierboven zou bij elke render een nieuwe functie per kolom maken, en dat is
 * precies wat `.claude/rules/code-conventions.md` verbiedt.
 */
export const SortableHeader = ({ column, sort, onSort }: SortableHeaderProps) => {
  const active = sort.key === column.key;

  const handleClick = () => {
    onSort({
      key: column.key,
      // Een nieuwe kolom begint aflopend voor cijfers en oplopend voor namen: dat is in
      // beide gevallen het antwoord waar iemand op klikt.
      direction: active
        ? sort.direction === 'asc'
          ? 'desc'
          : 'asc'
        : column.numeric
          ? 'desc'
          : 'asc',
    });
  };

  return (
    <TableHead className={cn(column.numeric && 'text-right')}>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleClick}
        className={cn('h-8 px-2', column.numeric && 'ml-auto')}
      >
        {column.label}
        {active ? (
          sort.direction === 'asc' ? (
            <ArrowUp className="ml-1 size-3.5" />
          ) : (
            <ArrowDown className="ml-1 size-3.5" />
          )
        ) : (
          <ArrowUpDown className="ml-1 size-3.5 opacity-40" />
        )}
      </Button>
    </TableHead>
  );
};
