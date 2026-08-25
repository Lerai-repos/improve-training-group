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
const Blokkerend = ({ issues }: IssuesProps) => {
  if (issues.length === 0) {
    return null;
  }
  const [eerste, ...rest] = issues;
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="grid gap-1">
        <p>{eerste.tekst}</p>
        {/*
          De rest hangt onder dezelfde melding in plaats van in een eigen kader. Drie rode
          balken onder elkaar lezen als drie problemen, terwijl het er in de praktijk één is
          met gevolgen — en de adviseur begint toch bovenaan.
        */}
        {rest.map((issue) => (
          <p key={`${issue.kind}-${issue.tekst}`} className="text-muted-foreground">
            {issue.tekst}
          </p>
        ))}
      </div>
    </div>
  );
};

/**
 * De lege velden op één regel, niet als stapel kaders.
 *
 * Elk hiervan is een voetnoot: het document komt er wel, met een zichtbare `«…»`-regel op die
 * plek. Ze allemaal hun eigen omlijnde vak geven zette footnotes op dezelfde visuele hoogte
 * als het ene ding dat écht in de weg staat.
 */
const LegeVelden = ({ issues }: IssuesProps) => {
  if (issues.length === 0) {
    return null;
  }
  const velden = issues.map((issue) => issue.tekst.split(' is leeg')[0]);
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground">
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Nog leeg, wordt een zichtbare regel in het document:{' '}
        <span className="text-foreground">{velden.join(', ')}</span>
      </span>
    </p>
  );
};

export interface DocumentsPanelProps {
  readonly documenten: readonly TabDocument[];
  readonly issues: readonly TabIssue[];
}

export const DocumentsPanel = ({ documenten, issues }: DocumentsPanelProps) => {
  /**
   * De acteurvraag hoort hier niet thuis, al blokkeert hij wél.
   *
   * De checklist zet zijn eigen melding pal naast de knop waar je hem beantwoordt, dus een
   * tweede rode balk hierboven zegt hetzelfde een halve pagina eerder. `kanGenereren` rekent
   * er nog gewoon mee — dit gaat alleen over wáár het staat.
   */
  const blokkerend = issues.filter((i) => i.blokkeert && i.kind !== 'acteur_onbeantwoord');
  const leeg = issues.filter((i) => i.kind === 'veld_leeg');

  return (
    <section className="grid gap-3 rounded-md border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">
        {documenten.length === 0
          ? 'Nog geen documenten'
          : `${documenten.length} document${documenten.length === 1 ? '' : 'en'}`}
      </h2>

      <Blokkerend issues={blokkerend} />

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

      <LegeVelden issues={leeg} />
    </section>
  );
};
