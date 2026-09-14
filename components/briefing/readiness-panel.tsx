'use client';

import { AlertTriangle, CircleCheck, CircleDashed } from 'lucide-react';

import { cn } from '@lib/utils';

import type { TabGereedheid, TabIssue } from '@lib/briefing/tab';

/**
 * Bovenaan de tab: wat er nog mist, en of de briefing compleet is.
 *
 * ITG's vraag was *"overzichtelijk maken wat er precies mist, voordat de briefing wordt
 * gegenereerd"*. Daarvoor stonden de meldingen verspreid: blokkades halverwege in het
 * documentenblok, lege velden als voetnoot eronder. Hier staan ze bij elkaar, met één label
 * dat zegt waar de briefing staat.
 *
 * Groen en oranje komen uit het Tailwind-palet, want `globals.css` heeft geen succes- of
 * waarschuwingstoken. Rood is wél het `destructive`-token.
 */

type Stand = 'compleet' | 'blokkeert' | 'ontbreekt';

const LABEL: Record<Stand, string> = {
  compleet: 'Compleet',
  blokkeert: 'Kan niet genereren',
  ontbreekt: 'Nog niet compleet',
};

const UITLEG: Record<Stand, string> = {
  compleet: 'Alles wat je zelf kunt invullen staat erin. Na genereren komt Brie op "Staat klaar".',
  blokkeert: 'Genereren kan pas als het rode punt is opgelost.',
  ontbreekt:
    'Genereren kan, maar dit komt als zichtbare regel in het document en Brie komt op ' +
    '"Begonnen, niet klaar".',
};

const LABEL_STIJL: Record<Stand, string> = {
  compleet: 'border-emerald-600/40 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
  blokkeert: 'border-destructive/40 bg-destructive/10 text-destructive',
  ontbreekt: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

const Regel = ({ issue }: { readonly issue: TabIssue }) => (
  <li className="flex items-start gap-2 text-sm">
    {issue.blokkeert ? (
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
    ) : (
      <CircleDashed className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
    )}
    <span>{issue.tekst}</span>
  </li>
);

export interface ReadinessPanelProps {
  readonly gereedheid: TabGereedheid;
}

export const ReadinessPanel = ({ gereedheid }: ReadinessPanelProps) => {
  const stand: Stand = gereedheid.compleet
    ? 'compleet'
    : gereedheid.blokkeert.length > 0
      ? 'blokkeert'
      : 'ontbreekt';

  return (
    <section
      className="grid gap-3 rounded-md border border-border bg-card p-4"
      data-testid="briefing-gereedheid"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {gereedheid.compleet ? 'Klaar om te genereren' : 'Wat er nog mist'}
        </h2>
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

      <p className="text-xs text-muted-foreground">{UITLEG[stand]}</p>

      {/* Blokkades eerst: daar begint de adviseur, en de rest heeft pas zin als die weg zijn. */}
      {!gereedheid.compleet && (
        <ul className="grid gap-1.5">
          {[...gereedheid.blokkeert, ...gereedheid.ontbreekt].map((issue) => (
            <Regel key={`${issue.kind}-${issue.tekst}`} issue={issue} />
          ))}
        </ul>
      )}
    </section>
  );
};
