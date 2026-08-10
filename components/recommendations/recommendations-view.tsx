'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@components/ui/button';
import { Skeleton } from '@components/ui/skeleton';
import { cn } from '@lib/utils';

import { failureMessage } from './format';
import { RecommendationTable } from './recommendation-table';
import { SortButton, SortPanel } from './sort-panel';
import { defaultDirection, type SortLevel } from './sorting';
import { useTrainerNames } from './use-trainer-names';

import type { MondayBridge } from './monday-client';
import type { RecommendationsApi } from './api';
import type { UseRecommendationView } from './use-recommendation-view';

/**
 * The whole item view: one training's recommended trainers.
 *
 * Takes the hook's result rather than calling it, so the rendering can be tested against
 * any state — `computing`, `unavailable`, a restricted caller — without a Monday iframe
 * or a backend. The page wires the real thing.
 */

interface RecommendationsViewProps {
  monday: MondayBridge;
  api: RecommendationsApi;
  view: UseRecommendationView;
}

export const RecommendationsView = ({ monday, view }: RecommendationsViewProps) => {
  const caps = view.status.kind === 'loaded' ? view.status.view.caps : null;

  /**
   * The sort chain, primary first — built by clicking headers.
   *
   * Two different defaults, because the two payloads are different contracts. A `full`
   * caller starts on total cost (the spec's *"Totale kosten = de sorteerkolom"*); a
   * restricted caller has no cost field at all, so `rank` is the only thing to order by.
   * Defaulting everyone to `rank` looks identical today only because ranking IS
   * cost-first — the moment that changes, a full caller would silently stop seeing the
   * cheapest trainer at the top.
   */
  const [sort, setSort] = useState<readonly SortLevel[] | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const sortButtonRef = useRef<HTMLButtonElement>(null);

  /**
   * Closing must return focus to the trigger.
   *
   * Every way out of the panel — Sluiten, Escape — unmounts the focused element, and the
   * browser then drops focus to `document.body`. A keyboard user would be silently sent
   * back to the top of the page instead of to the button they opened.
   */
  const closeSort = (): void => {
    setSortOpen(false);
    sortButtonRef.current?.focus();
  };
  const defaultKey = caps?.canViewFull ? 'totalCostCents' : 'rank';
  const effectiveSort: readonly SortLevel[] = sort ?? [
    { key: defaultKey, direction: defaultDirection(defaultKey) },
  ];

  // A different training, or a change in what this caller may see, invalidates a manual
  // chain — the columns it names may not even exist any more.
  useEffect(() => {
    setSort(null);
  }, [view.itemId, caps?.canViewFull]);

  const linkedIds = view.linked.kind === 'ready' ? view.linked.trainerItemIds : [];

  /**
   * Rows PLUS whoever is linked. A recalculate can drop the currently linked trainer
   * from the list entirely, and they still have to be nameable — otherwise the view
   * shows no selection at all and offers every new row as a fresh pick.
   */
  const trainerIds = useMemo(() => {
    const state = view.status.kind === 'loaded' ? view.status.view.state : null;
    const rowIds = state?.kind === 'ready' ? state.rows.map((row) => row.trainerItemId) : [];
    return [...new Set([...rowIds, ...linkedIds])];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- joined below, not by identity
  }, [view.status, linkedIds.join(',')]);

  const rows =
    view.status.kind === 'loaded' && view.status.view.state.kind === 'ready'
      ? view.status.view.state.rows
      : [];
  const names = useTrainerNames(monday, trainerIds);

  return (
    <div
      /* Monday's theme, applied to THIS container only.
       *
       * `monday-surface` re-points the shadcn tokens at Monday's own palette (#191B32
       * dark, #FFFFFF light) — our own dark is near-black and reads as a hole punched in
       * their workspace. `darkMode: ['class']` matches an ancestor, so the `dark` class
       * here themes everything inside and nothing outside.
       *
       * Deliberately NOT via `next-themes`: that preference is shared across the origin
       * and persisted, so setting it would rewrite the user's theme in every other tab,
       * and a storage event from one of those could flip the iframe back mid-session. */
      className={cn(
        'monday-surface flex min-h-screen flex-col gap-4 bg-background p-4 text-foreground',
        view.theme === 'dark' && 'dark'
      )}
    >
      <header className="relative flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold">Aanbevolen trainers</h1>
        <div className="flex items-center gap-2">
          <SortButton
            count={effectiveSort.length}
            open={sortOpen}
            buttonRef={sortButtonRef}
            onToggle={() => {
              setSortOpen((open) => !open);
            }}
          />
          {sortOpen && (
            <SortPanel
              sort={effectiveSort}
              onChange={setSort}
              canViewFull={caps?.canViewFull ?? false}
              onClose={closeSort}
            />
          )}
        {caps?.canPlan && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void view.recalculate()}
            disabled={view.busy}
          >
            {view.recalculating ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 size-4" />
            )}
            Opnieuw berekenen
          </Button>
        )}
        </div>
      </header>

      {view.warning !== null && (
        <Warning
          message={view.warning}
          onDismiss={view.dismissWarning}
          onReset={view.stale ? () => void view.reset() : null}
        />
      )}

      {names.error !== null && rows.length > 0 && (
        <Notice>
          De namen konden niet worden opgehaald — de lijst toont item-id&apos;s. ({names.error})
        </Notice>
      )}

      {/* Frozen, with the only way out beside it — otherwise the warning tells the
          planner to refresh while nothing on screen can. */}
      {view.stale && view.warning === null && (
        <Warning
          message="Deze lijst is verouderd."
          onDismiss={view.dismissWarning}
          onReset={() => void view.reset()}
        />
      )}

      <LinkedBanner view={view} names={names.byId} />

      <Body view={view} sort={effectiveSort} names={names.byId} />
    </div>
  );
};

/**
 * The live relation, rendered independently of the recommendation rows.
 *
 * A linked trainer marked only when they also appear in `rows` disappears the moment a
 * recalculate excludes them — and the view then shows no selection while offering every
 * row as a pick, which is how a colleague's choice gets overwritten.
 */
const LinkedBanner = ({
  view,
  names,
}: {
  view: UseRecommendationView;
  names: ReadonlyMap<string, string>;
}) => {
  if (view.linked.kind === 'error') {
    return (
      <Notice tone="error">
        De huidige trainerkoppeling kon niet worden gelezen, dus kiezen is uitgeschakeld — anders
        zou je de keuze van een collega kunnen overschrijven. ({view.linked.message})
      </Notice>
    );
  }

  if (view.linked.kind !== 'ready' || view.linked.trainerItemIds.length === 0) {
    return null;
  }

  const labels = view.linked.trainerItemIds.map((id) => names.get(id) ?? `#${id}`);
  return (
    <p className="text-sm">
      <span className="font-medium">Gekoppeld aan deze training: </span>
      {labels.join(', ')}
    </p>
  );
};

interface BodyProps {
  view: UseRecommendationView;
  sort: readonly SortLevel[];
  names: ReadonlyMap<string, string>;
}

/** The linked ids for the CURRENT item, or none while the relation is unknown. */
function linkedIdsOf(view: UseRecommendationView): readonly string[] {
  return view.linked.kind === 'ready' ? view.linked.trainerItemIds : [];
}

const Body = ({ view, sort, names }: BodyProps) => {
  if (view.status.kind === 'loading') {
    return <Skeleton className="h-40 w-full" />;
  }

  if (view.status.kind === 'error') {
    return <Notice tone="error">Er ging iets mis: {view.status.message}</Notice>;
  }

  const { state, caps } = view.status.view;

  switch (state.kind) {
    case 'idle':
      return (
        <Notice>
          Voor deze training zijn nog geen aanbevelingen berekend. Verplaats hem naar
          <strong> Inplannen</strong>, of bereken opnieuw.
        </Notice>
      );

    case 'computing':
      return (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Bezig met berekenen…
        </div>
      );

    case 'no_match':
      // An answer, not a missing computation — say so, or a planner assumes it broke.
      return (
        <Notice>
          Geen enkele trainer is gekwalificeerd (en beschikbaar) voor alle thema&apos;s van deze
          training.
        </Notice>
      );

    case 'failed':
      return <Notice tone="error">{failureMessage(state.stage)}</Notice>;

    case 'unavailable':
      // Deliberately not a spinner: this will never resolve on its own.
      return (
        <Notice>
          De lijst van deze berekening is niet meer beschikbaar (uitkomst: {state.label}). Bereken
          opnieuw om een actuele lijst te krijgen.
        </Notice>
      );

    case 'ready':
      return (
        <RecommendationTable
          rows={state.rows}
          names={names}
          canViewFull={caps.canViewFull}
          canPlan={caps.canPlan}
          sort={sort}
          onApproachedChange={(trainerItemId, approached) => {
            void view.setApproached(trainerItemId, approached);
          }}
          onPick={(trainerItemId) => {
            void view.pick(trainerItemId);
          }}
          picking={view.picking}
          linkedTrainerIds={linkedIdsOf(view)}
          canPick={view.linked.kind === 'ready'}
          busy={view.busy}
          stale={view.stale}
        />
      );
  }
};

const Notice = ({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'error';
}) => (
  <p className={tone === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
    {children}
  </p>
);

interface WarningProps {
  message: string;
  onDismiss: () => void;
  /** Present only when the view is frozen and there is something to recover from. */
  onReset: (() => void) | null;
}

const Warning = ({ message, onDismiss, onReset }: WarningProps) => (
  <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
    <span className="flex-1">{message}</span>
    {onReset !== null && (
      <Button variant="outline" size="sm" onClick={onReset}>
        Ververs lijst
      </Button>
    )}
    <Button variant="ghost" size="sm" onClick={onDismiss}>
      Sluiten
    </Button>
  </div>
);
