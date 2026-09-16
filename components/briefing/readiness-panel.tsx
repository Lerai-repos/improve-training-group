'use client';

import { useId, useState } from 'react';
import { AlertTriangle, CircleCheck, CircleDashed, ChevronDown } from 'lucide-react';

import { cn } from '@lib/utils';

import type { TabControle, TabGereedheid } from '@lib/briefing/tab';

/**
 * De checklist bovenaan de tab: wat klopt, wat ontbreekt, en wat genereren tegenhoudt.
 *
 * Tim, 16-Sep-2026: een vinkje bij alles wat er staat, korte regels van een paar woorden, en
 * de uitleg pas bij een klik. Een lijst volzinnen las als een foutmelding; zo is in één
 * oogopslag te zien waar de briefing staat.
 *
 * Groen en oranje komen uit het Tailwind-palet, want `globals.css` heeft geen succes- of
 * waarschuwingstoken. Rood is het `destructive`-token.
 */

type Stand = 'compleet' | 'blokkeert' | 'ontbreekt';

const LABEL: Record<Stand, string> = {
  compleet: 'Compleet',
  blokkeert: 'Kan niet genereren',
  ontbreekt: 'Nog niet compleet',
};

const LABEL_STIJL: Record<Stand, string> = {
  compleet: 'border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
  blokkeert: 'border-destructive/40 bg-destructive/10 text-destructive',
  ontbreekt: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

function samenvatting(controles: readonly TabControle[]): string {
  const blokkeert = controles.filter((c) => c.status === 'blokkeert').length;
  const ontbreekt = controles.filter((c) => c.status === 'ontbreekt').length;
  if (blokkeert > 0) {
    return `${blokkeert} ${blokkeert === 1 ? 'punt houdt' : 'punten houden'} genereren tegen.`;
  }
  if (ontbreekt > 0) {
    return `${ontbreekt} ${ontbreekt === 1 ? 'punt ontbreekt' : 'punten ontbreken'}. Genereren kan, Brie komt dan op "Begonnen, niet klaar".`;
  }
  return 'Alles staat erin. Na genereren komt Brie op "Staat klaar".';
}

const Icoon = ({ status }: { readonly status: TabControle['status'] }) => {
  if (status === 'blokkeert') {
    return <AlertTriangle className="size-4 shrink-0 text-destructive" />;
  }
  if (status === 'ontbreekt') {
    return <CircleDashed className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />;
  }
  return <CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />;
};

/**
 * Eén regel: het label is een knop, de uitleg klapt eronder open.
 *
 * Het openklappen animeert de rijhoogte van een grid van `0fr` naar `1fr`. Dat is de enige
 * manier om naar de natuurlijke hoogte van de inhoud te schuiven zonder die hoogte te meten.
 */
const Regel = ({ controle }: { readonly controle: TabControle }) => {
  const [open, setOpen] = useState(false);
  const id = useId();
  const handleToggle = () => {
    setOpen((was) => !was);
  };

  return (
    <li className="rounded-md hover:bg-muted/40">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icoon status={controle.status} />
        <span className={cn('flex-1', controle.status !== 'ok' && 'font-medium')}>
          {controle.label}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
            open && 'rotate-180'
          )}
        />
      </button>
      <div
        id={id}
        aria-hidden={!open}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="overflow-hidden">
          <p className="px-2 pb-2 pl-8 text-xs text-muted-foreground">
            {controle.uitleg === '' ? 'Ingevuld.' : controle.uitleg}
          </p>
        </div>
      </div>
    </li>
  );
};

export interface ReadinessPanelProps {
  readonly gereedheid: TabGereedheid;
}

export const ReadinessPanel = ({ gereedheid }: ReadinessPanelProps) => {
  const stand: Stand = gereedheid.compleet
    ? 'compleet'
    : gereedheid.controles.some((c) => c.status === 'blokkeert')
      ? 'blokkeert'
      : 'ontbreekt';

  return (
    <section
      className="grid gap-3 rounded-md border border-border bg-card p-4"
      data-testid="briefing-gereedheid"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Checklist</h2>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
            LABEL_STIJL[stand]
          )}
        >
          {stand === 'compleet' && <CircleCheck className="size-3.5" />}
          {LABEL[stand]}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">{samenvatting(gereedheid.controles)}</p>

      <ul className="grid items-start gap-x-4 sm:grid-cols-2">
        {gereedheid.controles.map((controle) => (
          <Regel key={controle.key} controle={controle} />
        ))}
      </ul>
    </section>
  );
};
