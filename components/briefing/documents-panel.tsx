'use client';

import { FileText } from 'lucide-react';

import type { TabDocument } from '@lib/briefing/tab';

/**
 * Wat er uit Genereren komt, vóórdat er iets gemaakt wordt.
 *
 * Eén training kan acht documenten opleveren — een lead, een co-trainer en zes acteurs — en
 * dat verrast iedereen die het voor het eerst ziet. Dus staat het er, met naam en rol, naast
 * de knop die het doet.
 *
 * Wat er nog mist staat hier niet meer maar bovenaan, in `ReadinessPanel`: verspreid over dit
 * blok en een voetnoot eronder was het niet in één oogopslag te zien.
 */

const ROL_LABEL: Record<TabDocument['role'], string> = {
  lead: 'Leadtrainer',
  co: 'Co-trainer',
  acteur: 'Trainingsacteur',
};

export interface DocumentsPanelProps {
  readonly documenten: readonly TabDocument[];
}

export const DocumentsPanel = ({ documenten }: DocumentsPanelProps) => (
  <section className="grid gap-3 rounded-md border border-border bg-card p-4">
    <h2 className="text-sm font-semibold">
      {documenten.length === 0
        ? 'Nog geen documenten'
        : `${documenten.length} document${documenten.length === 1 ? '' : 'en'}`}
    </h2>

    {documenten.length > 0 && (
      <ul className="grid gap-1">
        {documenten.map((doc) => (
          <li key={doc.itemId} className="flex items-center gap-2 text-sm">
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-medium">{doc.naam}</span>
            <span className="text-xs text-muted-foreground">{ROL_LABEL[doc.role]}</span>
          </li>
        ))}
      </ul>
    )}
  </section>
);
