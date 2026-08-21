'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@components/ui/button';
import { Skeleton } from '@components/ui/skeleton';
import { cn } from '@lib/utils';

import { failureMessage, hours } from './format';
import { PickConfirmDialog, type PendingPick } from './pick-confirm-dialog';
import { RecommendationTable } from './recommendation-table';
import { SortButton, SortPanel } from './sort-panel';
import { useDismissiblePanel } from './use-dismissible-panel';
import { WhatsappButton, WhatsappPanel } from './whatsapp-panel';
import { useWhatsappMessage } from './use-whatsapp-message';
import type { SortLevel } from './sorting';
import { useTrainerNames } from './use-trainer-names';
import { useTrainingDate } from './use-training-date';

import type { MondayBridge } from './monday-client';
import type { MessageState } from './whatsapp-link';
import type { PickMode } from './pick-trainer';
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

export const RecommendationsView = ({ monday, api, view }: RecommendationsViewProps) => {
  const caps = view.status.kind === 'loaded' ? view.status.view.caps : null;

  /**
   * The sort chain, primary first — empty by default.
   *
   * Empty IS the engine's recommended order, because `sortRows` falls back to `rank`. So
   * the list arrives the way the engine ranked it, Reset returns to exactly that, and
   * there is no "Aanbevolen volgorde" column duplicating the fallback.
   */
  const [sort, setSort] = useState<readonly SortLevel[] | null>(null);
  const effectiveSort: readonly SortLevel[] = sort ?? [];

  /**
   * Two panels, one at a time. Opening either closes the other — they occupy the same
   * corner, and two overlapping popovers is nobody's idea of a toolbar.
   */
  const [panel, setPanel] = useState<'sort' | 'whatsapp' | null>(null);
  const sortOpen = panel === 'sort';
  const whatsappOpen = panel === 'whatsapp';

  /**
   * The current generation, used to re-read the message after a recalculate.
   *
   * That is the moment the training was last read from Monday, so it is also the moment a
   * changed date, time or location reaches the text the row links will send.
   */
  const generation =
    view.status.kind === 'loaded' && view.status.view.state.kind !== 'idle'
      ? view.status.view.state.generation
      : null;

  /**
   * `preload` is separate from `whatsappOpen`, not folded into it.
   *
   * Every row's WhatsApp link is built from this text, so it must be in hand before anyone
   * clicks — an `<a href>` cannot await, and a window opened after one is popup-blocked.
   * But the hook loads on the rising edge of its `open` argument, so holding that true
   * would fire once per training and never again.
   */
  const whatsapp = useWhatsappMessage(api, view.itemId, whatsappOpen, {
    preload: caps?.canPlan === true,
    refreshToken: generation,
  });

  /**
   * Whether the message is safe to send from a row, with no panel to explain itself.
   *
   * `error` covers the case that has no other way out: a refresh failed, so the text on
   * hand is the PREVIOUS message, and nothing would re-read it until someone opened the
   * panel. Left enabled, those links quietly send the old date to every trainer on a
   * freshly recalculated list.
   *
   * `pending` is the same failure a beat earlier: a new generation renders immediately
   * while its message GET is still in flight, so for that window the list is new and the
   * text is not. It also covers a refresh deferred behind an unsaved draft.
   */
  const messageState: MessageState =
    whatsapp.loadError !== null
      ? 'error'
      : whatsapp.save.kind === 'conflict'
        ? 'conflict'
        : whatsapp.unreadable
        ? 'unreadable'
        : whatsapp.stale
          ? 'stale'
          : whatsapp.refreshPending
            ? 'pending'
            : 'ok';

  /**
   * EVERY way out of the WhatsApp panel saves first, and a failed save cancels the
   * dismissal.
   *
   * Not just Sluiten and Escape: an outside click, losing the iframe's focus, and
   * pressing Sorteren all remove the panel too, and routing only the polite exits
   * through `flush` meant the other three hid a failed autosave and let the next load
   * overwrite the draft. The panel that reports the error has to still be on screen.
   */
  const leaveWhatsapp = useCallback(
    (next: 'sort' | 'whatsapp' | null): void => {
      void whatsapp.flush().then((saved) => {
        if (saved) {
          setPanel(next);
        }
      });
    },
    [whatsapp]
  );

  const requestPanel = useCallback(
    (next: 'sort' | 'whatsapp' | null): void => {
      if (whatsappOpen && next !== 'whatsapp') {
        leaveWhatsapp(next);
        return;
      }
      setPanel(next);
    },
    [whatsappOpen, leaveWhatsapp]
  );

  const closeSortPanel = useCallback((): void => {
    setPanel(null);
  }, []);
  const closeWhatsappPanel = useCallback((): void => {
    leaveWhatsapp(null);
  }, [leaveWhatsapp]);

  const sortPanel = useDismissiblePanel<HTMLDivElement>(sortOpen, closeSortPanel);
  const whatsappPanel = useDismissiblePanel<HTMLDivElement>(whatsappOpen, closeWhatsappPanel);

  const toggleSort = useCallback((): void => {
    requestPanel(sortOpen ? null : 'sort');
  }, [requestPanel, sortOpen]);
  const toggleWhatsapp = useCallback((): void => {
    requestPanel(whatsappOpen ? null : 'whatsapp');
  }, [requestPanel, whatsappOpen]);

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
  const names = useTrainerNames(monday, trainerIds, { includePhones: caps?.canPlan === true });

  /** The training's own date, read live — see `use-training-date.ts`. */
  const trainingDate = useTrainingDate(monday, view.itemId);

  /**
   * A pick that needs an answer before it can be written — see `PickConfirmDialog`.
   *
   * Only a SECOND trainer raises the question. With an empty relation there is nothing to
   * replace and nothing to add to, so Kies stays a single click; the already-linked row's
   * own button is disabled, so the remaining case is always "a different trainer, on a
   * training that already has one".
   */
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);

  // A different training invalidates a question asked about the previous one.
  useEffect(() => {
    setPendingPick(null);
  }, [view.itemId]);

  const requestPick = useCallback(
    (trainerItemId: string): void => {
      if (linkedIds.length === 0 || linkedIds.includes(trainerItemId)) {
        /**
         * `append`, not `replace`, even though the relation looks empty.
         *
         * This list is up to 20 seconds old, so "empty" may mean "a colleague linked
         * someone since the last poll" — and replacing would delete them without asking.
         * For a genuinely empty relation the two are identical; when it is not empty,
         * append re-reads at write time and keeps them. `replace` is reachable only from
         * the dialog, where a human said so.
         */
        void view.pick(trainerItemId, 'append');
        return;
      }
      setPendingPick({ trainerItemId, name: names.byId.get(trainerItemId) ?? null });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- joined below, not by identity
    [linkedIds.join(','), names.byId, view]
  );

  const decidePick = useCallback(
    (trainerItemId: string, mode: PickMode): void => {
      setPendingPick(null);
      void view.pick(trainerItemId, mode);
    },
    [view]
  );

  const cancelPick = useCallback((): void => {
    setPendingPick(null);
  }, []);

  /**
   * Before the context arrives we know neither the theme nor the item, so anything
   * rendered now is rendered in a guess.
   *
   * A transparent background was only half the fix: the heading, and especially the
   * outline Sort button with its own `bg-background`, still paint in light tokens — so a
   * dark workspace gets a pale button and dark text for the length of one postMessage
   * round trip. An empty transparent shell has nothing to be wrong about.
   *
   * A context FAILURE is different and must still render: that error is the only thing
   * telling the planner why the view is empty.
   */
  const pending = view.theme === null && view.status.kind !== 'error';

  /**
   * Context failed, so we will NEVER learn the theme — and unlike `pending`, this is not
   * a moment that passes.
   *
   * Rendering the normal view here would leave the header and an active Sort control
   * painted in light tokens over a dark workspace, permanently, above a list that cannot
   * load. So this state gets its own surface: an opaque white card, legible against
   * either Monday theme, carrying the message and nothing to click.
   */
  if (view.theme === null && view.status.kind === 'error') {
    return (
      <div className="flex min-h-screen flex-col gap-4 p-4">
        <div className="rounded-md border border-[#D0D4E4] bg-white p-4 text-sm text-[#323338]">
          <p className="mb-1 font-medium">De aanbevelingen konden niet worden geladen.</p>
          <p className="text-[#676879]">{view.status.message}</p>
        </div>
      </div>
    );
  }

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
        'monday-surface flex min-h-screen flex-col gap-4 p-4 text-foreground',
        // No background until Monday has told us which one. Painting a guess is what
        // produces the white flash in a dark workspace; transparent lets the host's own
        // backdrop show through for the moment it takes the context to arrive.
        view.theme === null ? 'bg-transparent' : 'bg-background',
        view.theme === 'dark' && 'dark'
      )}
    >
      {pending ? null : (
        <>
          <header className="relative flex items-center justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold">Aanbevolen trainers</h1>
              {/* Left out entirely when there is no date to show, rather than held open
              with a dash: an empty slot under the heading reads as a missing value on a
              training that may simply not be dated yet. */}
              {trainingDate.label !== null && (
                <p className="text-sm text-muted-foreground">{trainingDate.label}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* The outside-click boundary is the trigger and panel ALONE. Wrapping the
              whole group would count Recalculate as "inside", leaving the panel hanging
              open over a list that is about to be replaced. */}
              <div ref={sortPanel.areaRef} className="relative">
                <SortButton
                  count={effectiveSort.length}
                  open={sortOpen}
                  buttonRef={sortPanel.triggerRef}
                  onToggle={toggleSort}
                />
                {sortOpen && (
                  <SortPanel
                    sort={effectiveSort}
                    onChange={setSort}
                    canViewFull={caps?.canViewFull ?? false}
                    onClose={sortPanel.close}
                  />
                )}
              </div>
              {caps?.canPlan && (
                <div ref={whatsappPanel.areaRef} className="relative">
                  <WhatsappButton
                    open={whatsappOpen}
                    buttonRef={whatsappPanel.triggerRef}
                    onToggle={toggleWhatsapp}
                  />
                  {whatsappOpen && (
                    <WhatsappPanel message={whatsapp} onClose={whatsappPanel.close} />
                  )}
                </div>
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

          {/* Nothing is painted until Monday's theme is known — see `pending` above. */}
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

          {/* The message's own quality warnings, shown ONCE and visibly.
              They describe the training's message, so repeating them per row would say
              the same thing 24 times — and a `title` tooltip never reaches a keyboard or
              touch user, who would then send an incomplete message without ever being
              told. Non-blocking, exactly as the panel treats them. */}
          {caps?.canPlan === true && whatsapp.warnings.length > 0 && (
            <Notice tone="warning">
              WhatsApp-bericht: {whatsapp.warnings.join(' · ')}
            </Notice>
          )}

          <LinkedBanner view={view} names={names.byId} />

          <Body
            view={view}
            sort={effectiveSort}
            names={names.byId}
            phones={names.phoneById}
            message={whatsapp.text}
            messageState={messageState}
            onPick={requestPick}
          />

          <PickConfirmDialog
            pending={pendingPick}
            linkedLabels={linkedIds.map((id) => names.byId.get(id) ?? `#${id}`)}
            onDecide={decidePick}
            onCancel={cancelPick}
          />
        </>
      )}
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
  /** Only trainers who have one on the board — the rest get no WhatsApp link. */
  phones: ReadonlyMap<string, string>;
  /** The training's message, personalised per row when the link is built. */
  message: string;
  /** Whether the message is safe to send — see `MessageState`. */
  messageState: MessageState;
  /** Routed through the view so a second trainer can raise the replace/append question. */
  onPick: (trainerItemId: string) => void;
}

/** The linked ids for the CURRENT item, or none while the relation is unknown. */
function linkedIdsOf(view: UseRecommendationView): readonly string[] {
  return view.linked.kind === 'ready' ? view.linked.trainerItemIds : [];
}

const Body = ({
  view,
  sort,
  names,
  phones,
  message,
  messageState,
  onPick,
}: BodyProps) => {
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
        <>
          <TrainingHours
            duurTraining={state.duurTraining ?? null}
            // Constant across the list — it derives from the training's duration, not
            // from the trainer — so one row is as good as any, and repeating it down 24
            // rows as a column would say the same thing 24 times.
            billableHours={state.rows[0]?.billableHours ?? null}
            canViewFull={caps.canViewFull}
          />
          <RecommendationTable
          rows={state.rows}
          names={names}
          phones={phones}
          message={message}
          messageState={messageState}
          canViewFull={caps.canViewFull}
          canPlan={caps.canPlan}
          sort={sort}
          onApproachedChange={(trainerItemId, approached) => {
            void view.setApproached(trainerItemId, approached);
          }}
          onPick={onPick}
          picking={view.picking}
          linkedTrainerIds={linkedIdsOf(view)}
          canPick={view.linked.kind === 'ready'}
          busy={view.busy}
          stale={view.stale}
          />
        </>
      );
  }
};

interface TrainingHoursProps {
  duurTraining: number | null;
  billableHours: number | null;
  canViewFull: boolean;
}

/**
 * "Duur training 2,00 · Duur facturatie 3,00" — the training's own hours, above the list.
 *
 * A session under four hours bills more than it runs (`((4 − duur) / 2) + duur`, so 2h
 * bills 3), which is why Totale kosten looks too high until you know the rule. Airtable
 * puts both figures on the training record; the popup showed neither, so the planner had
 * to leave to reconcile a number in front of them.
 *
 * Not a table column: both are properties of the TRAINING and identical on every row.
 *
 * Facturatie is `canViewFull` only — it is a billing figure, and the restricted shape
 * carries no money. Duur training is just how long the session is, so everyone sees it.
 */
const TrainingHours = ({ duurTraining, billableHours, canViewFull }: TrainingHoursProps) => {
  // Nothing known, nothing to say — never a misleading `0,00`.
  if (duurTraining === null && !(canViewFull && billableHours !== null)) {
    return null;
  }

  return (
    <p className="flex gap-4 text-sm text-muted-foreground">
      <span>
        Duur training <span className="font-medium text-foreground">{hours(duurTraining)}</span>
      </span>
      {canViewFull && billableHours !== null && (
        <span>
          Duur facturatie <span className="font-medium text-foreground">{hours(billableHours)}</span>
        </span>
      )}
    </p>
  );
};

const Notice = ({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'error' | 'warning';
}) => (
  <p
    className={cn(
      'text-sm',
      tone === 'error'
        ? 'text-destructive'
        : tone === 'warning'
          ? 'flex items-start gap-2 text-foreground'
          : 'text-muted-foreground'
    )}
  >
    {tone === 'warning' && <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />}
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
