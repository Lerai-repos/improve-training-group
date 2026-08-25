'use client';

import { AlertTriangle, Check, Loader2 } from 'lucide-react';

import { Button } from '@components/ui/button';
import { Skeleton } from '@components/ui/skeleton';
import { cn } from '@lib/utils';

import { ChecklistPanel } from './checklist-panel';
import { ConceptPanel } from './concept-panel';
import { DocumentsPanel } from './documents-panel';

import type { UseBriefingView } from './use-briefing-view';

/**
 * De hele tab: de briefing van één training.
 *
 * Neemt het resultaat van de hook aan in plaats van hem aan te roepen, zodat elke toestand —
 * laden, een training zonder leadtrainer, een botsing, een onleesbaar record — te renderen is
 * zonder Monday-iframe en zonder backend. De pagina bedraadt het echte spul.
 */

interface BriefingViewProps {
  readonly view: UseBriefingView;
}

const SaveStatus = ({ save }: { save: UseBriefingView['save'] }) => {
  if (save.kind === 'bezig') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> opslaan…
      </span>
    );
  }
  if (save.kind === 'bewaard') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check className="size-3" /> opgeslagen
      </span>
    );
  }
  if (save.kind === 'mislukt') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <AlertTriangle className="size-3" /> niet opgeslagen: {save.message}
      </span>
    );
  }
  return null;
};

export const BriefingView = ({ view }: BriefingViewProps) => {
  const handleRefresh = () => {
    view.refresh();
  };
  const handleUnlock = () => {
    view.unlock();
  };
  const handleConcept = (next: string | undefined) => {
    view.setChecklist({ conceptInhoud: next });
  };

  /**
   * Zolang de context niet binnen is weten we het thema niet, en dus ook niet welke kleuren
   * kloppen. Een gok schilderen is precies wat de witte flits in een donkere werkruimte geeft;
   * een lege doorzichtige schil heeft niets om fout aan te zijn.
   *
   * Een mislukte context is iets anders en moet wél renderen: die melding is het enige dat de
   * adviseur vertelt waarom hij een leeg scherm ziet. Die krijgt daarom een eigen ondergrond
   * die in beide thema's leesbaar is.
   */
  if (view.theme === null && view.status.kind === 'error') {
    return (
      <div className="flex min-h-screen flex-col gap-4 p-4">
        <div className="rounded-md border border-[#D0D4E4] bg-white p-4 text-sm text-[#323338]">
          <p className="mb-1 font-medium">De briefing kon niet worden geladen.</p>
          <p className="text-[#676879]">{view.status.message}</p>
        </div>
      </div>
    );
  }

  /*
   * Monday's thema, alleen op déze container.
   *
   * `monday-surface` richt de shadcn-tokens op Monday's eigen palet (#191B32 donker, #FFFFFF
   * licht); ons eigen donker is bijna zwart en leest als een gat in hun werkruimte.
   * `darkMode: ['class']` kijkt naar een voorouder, dus deze klasse thematiseert alles
   * erbinnen en niets erbuiten.
   */
  const surface = cn(
    'monday-surface flex min-h-screen flex-col gap-4 p-4 text-foreground',
    view.theme === null ? 'bg-transparent' : 'bg-background',
    view.theme === 'dark' && 'dark'
  );

  if (view.theme === null || view.status.kind === 'loading') {
    return (
      <div className={surface}>
        {view.theme === null ? null : (
          <>
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </>
        )}
      </div>
    );
  }

  if (view.status.kind === 'error') {
    return (
      <div className={surface}>
        <div className="rounded-md border border-border bg-card p-4 text-sm">
          <p className="mb-1 font-medium">De briefing kon niet worden geladen.</p>
          <p className="text-muted-foreground">{view.status.message}</p>
        </div>
        <div>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            Opnieuw proberen
          </Button>
        </div>
      </div>
    );
  }

  const { view: tab } = view.status;

  return (
    <div className={surface} data-testid="briefing-view">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Briefing</h1>
          <p className="text-sm text-muted-foreground">
            {tab.training.opdrachtgever} · {tab.training.klanttitel}
            {tab.training.datum !== '' && ` · ${tab.training.datum}`}
          </p>
        </div>
        <SaveStatus save={view.save} />
      </header>

      {/**
       * Een botsing is geen fout maar een vraag: iemand anders heeft opgeslagen terwijl deze
       * tab open stond. Blind doorschrijven zou hun werk wissen, dus tonen we het en bieden we
       * opnieuw laden aan.
       */}
      {view.save.kind === 'conflict' && (
        <div className="flex items-start justify-between gap-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <p>
            Iemand anders heeft deze checklist intussen opgeslagen. Laad opnieuw om hun versie te
            zien; jouw laatste wijziging is niet bewaard.
          </p>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            Opnieuw laden
          </Button>
        </div>
      )}

      {/**
       * Er staan antwoorden die we niet kunnen lezen. Het formulier hieronder staat dus leeg,
       * en dat leest als "nog niets ingevuld" — terwijl één vinkje die onbekende antwoorden
       * zou overschrijven. Daarom is bewerken geblokkeerd tot iemand dat expliciet wil.
       */}
      {view.locked && (
        <div className="flex items-start justify-between gap-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <p>
            Er staan antwoorden opgeslagen die niet te lezen zijn. Het formulier hieronder is
            daarom leeg én vergrendeld: doorgaan overschrijft wat er stond.
          </p>
          <Button variant="outline" size="sm" onClick={handleUnlock}>
            Opnieuw invullen
          </Button>
        </div>
      )}

      <DocumentsPanel documenten={tab.documenten} issues={tab.issues} />

      <fieldset disabled={view.locked} className={cn(view.locked && 'opacity-60')}>
        <div className="flex flex-col gap-4">
          <ChecklistPanel
            /**
             * De uitgerekende checklist, niet de rauwe antwoorden.
             *
             * Zolang de acteurvraag onbeantwoord is past `buildTabView` Monday's voorstel toe.
             * De rauwe antwoorden doorgeven liet de radioknop dan `Nee` tonen — en de
             * acteurkiezer verbergen — terwijl het voorbeeld eronder wél van een acteur uitging.
             */
            checklist={tab.checklist}
            acteurBeantwoord={tab.acteurBeantwoord}
            acteurVoorstel={tab.acteurVoorstel}
            personen={tab.personen}
            actorItemIds={view.answers.actorItemIds}
            mondayChallenge={view.answers.mondayChallenge}
            onChecklist={view.setChecklist}
            onActors={view.setActorItemIds}
            onMondayChallenge={view.setMondayChallenge}
            onAnswerActor={view.answerActor}
          />

          <ConceptPanel
            skelet={tab.conceptSkelet}
            eigen={tab.checklist.conceptInhoud ?? null}
            resultaat={tab.conceptResultaat}
            onChange={handleConcept}
          />
        </div>
      </fieldset>

      {/**
       * Genereren komt hierna. De knop staat er bewust nog niet: wat er ná het indrukken
       * gebeurt hangt aan de open vraag of het document naar SharePoint gaat of als PDF
       * gemaild wordt, en dat is het enige deel van deze tab dat daarvan afhangt.
       */}
      <p className="text-xs text-muted-foreground">
        Genereren wordt hierna aangesloten; de antwoorden hierboven worden al bewaard.
      </p>
    </div>
  );
};
