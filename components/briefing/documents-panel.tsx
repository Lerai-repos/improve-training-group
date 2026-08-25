'use client';

import { AlertTriangle, FileText, Info } from 'lucide-react';

import { cn } from '@lib/utils';

import type { TabDocument, TabIssue } from '@lib/briefing/tab';

/**
 * Wat er uit Genereren komt, vóórdat er iets gemaakt wordt.
 *
 * Eén training kan acht documenten opleveren — een lead, een co-trainer en zes acteurs — en
 * dat verrast iedereen die het voor het eerst ziet. Dus staat het er, met naam en rol, naast
 * de knop die het doet.
 */

const ROL_LABEL: Record<TabDocument['role'], string> = {
  lead: 'Leadtrainer',
  co: 'Co-trainer',
  acteur: 'Trainingsacteur',
};

interface IssuesProps {
  readonly issues: readonly TabIssue[];
}

/**
 * Blokkerend en niet-blokkerend zien er anders uit, want ze vragen iets anders.
 *
 * Een lege achtergrondtekst is een melding: het document komt er wel, met een zichtbare regel
 * op die plek. Twee mensen in de leadkolom is een opdracht: daar moet iemand iets aan doen
 * voordat er ook maar één document klopt.
 */
const Issues = ({ issues }: IssuesProps) => {
  if (issues.length === 0) {
    return null;
  }
  return (
    <ul className="grid gap-2">
      {issues.map((issue) => (
        <li
          key={`${issue.kind}-${issue.tekst}`}
          className={cn(
            'flex items-start gap-2 rounded-md border p-2 text-xs',
            issue.blokkeert
              ? 'border-destructive/40 bg-destructive/10 text-foreground'
              : 'border-border bg-muted/40 text-muted-foreground'
          )}
        >
          {issue.blokkeert ? (
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          ) : (
            <Info className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>{issue.tekst}</span>
        </li>
      ))}
    </ul>
  );
};

export interface DocumentsPanelProps {
  readonly documenten: readonly TabDocument[];
  readonly issues: readonly TabIssue[];
}

export const DocumentsPanel = ({ documenten, issues }: DocumentsPanelProps) => {
  const blokkerend = issues.filter((i) => i.blokkeert);
  const meldingen = issues.filter((i) => !i.blokkeert);

  return (
    <section className="grid gap-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">
        {documenten.length === 0
          ? 'Nog geen documenten'
          : `${documenten.length} document${documenten.length === 1 ? '' : 'en'}`}
      </h2>

      <Issues issues={blokkerend} />

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

      <Issues issues={meldingen} />
    </section>
  );
};
