'use client';

import { AlertTriangle, CircleCheck, CircleDashed } from 'lucide-react';

import type { TabInventarisatie } from '@lib/briefing/tab';

/**
 * Eén regel: heeft de klant het inventarisatieformulier ingevuld?
 *
 * Los van de checklist erboven, want de student kan er niets aan doen: de klant vult hem in, via
 * de link op de Opportunity. De antwoorden zelf staan in het document onder "Inventarisatie klant".
 */
export const InventarisatieRegel = ({ stand }: { readonly stand: TabInventarisatie }) => {
  if (stand.kind === 'niet-gelezen') {
    return null;
  }
  return (
    <section className="flex items-start gap-2 rounded-md border border-border bg-card p-3 text-sm">
      {stand.kind === 'ingevuld' && (
        <>
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <p>
            <span className="font-semibold">Inventarisatie: </span>
            Ingevuld door de klant op {stand.op} ({stand.aantal}{' '}
            {stand.aantal === 1 ? 'antwoord' : 'antwoorden'}). Staat in het document.
          </p>
        </>
      )}
      {stand.kind === 'leeg' && (
        <>
          <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">
            <span className="font-semibold text-foreground">Inventarisatie: </span>
            Nog niet ingevuld door de klant. De link staat op de Opportunity, in de kolom
            Inventarisatieformulier.
          </p>
        </>
      )}
      {stand.kind === 'geen-opportunity' && (
        <>
          <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">
            <span className="font-semibold text-foreground">Inventarisatie: </span>
            Geen Opportunity gekoppeld aan deze training, dus ook geen inventarisatieformulier.
          </p>
        </>
      )}
      {stand.kind === 'onleesbaar' && (
        <>
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <p>
            <span className="font-semibold">Inventarisatie: </span>
            Het formulier kon niet worden gelezen ({stand.fout}). Probeer het later opnieuw.
          </p>
        </>
      )}
    </section>
  );
};
