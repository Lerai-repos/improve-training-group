'use client';

import { ArrowDown, ArrowUp, Check, Loader2, MessageCircle } from 'lucide-react';

import { Button } from '@components/ui/button';
import { Checkbox } from '@components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@components/ui/table';
import { cn } from '@lib/utils';

import { duration, euros, grade } from './format';
import {
  levelOf,
  maxTheme,
  sortRows,
  themeBreakdown,
  travelMarginCents,
  type SortKey,
  type SortLevel,
} from './sorting';

import { whatsappHref, type MessageState } from './whatsapp-link';

import type { Row } from './types';

/**
 * The ranked list.
 *
 * **Two column sets, chosen by capability.** A `full` caller sees the money, the grades
 * and the workload; a restricted caller receives none of those fields at all, so their
 * table is genuinely narrower rather than hiding columns it holds.
 *
 * **No default sort, for anyone.** The rows arrive in the engine's own ranking and stay
 * there until the planner builds a chain in the Sort panel — `sortRows` falls back to
 * `rank` on an empty chain, which is also what Reset returns to. (The spec's *"Totale
 * kosten = de sorteerkolom"* is satisfied only incidentally today, because that ranking
 * IS cost-first; if phase 3 makes it score-first, the opening order follows it.)
 *
 * Headers show their place in the chain but do not change it — priority is explicit and
 * reorderable in the panel, where clicking headers could only ever imply it.
 *
 * Sorting is client-side over an already-complete list: at most a few dozen rows, and a
 * round trip to reorder them would be slower and could return a different generation.
 */

interface RecommendationTableProps {
  rows: Row[];
  names: ReadonlyMap<string, string>;
  /** Only trainers who have one on the board; the rest get no WhatsApp link. */
  phones: ReadonlyMap<string, string>;
  /** The training's message. Personalised per row — see `whatsapp-link.ts`. */
  message: string;
  /** Whether the message is safe to send from a row — see {@link MessageState}. */
  messageState: MessageState;
  canViewFull: boolean;
  canPlan: boolean;
  /** The sort chain, primary first. Clicking a header rebuilds it. */
  sort: readonly SortLevel[];
  onApproachedChange: (trainerItemId: string, approached: boolean) => void;
  /** Link this trainer to the training. Written client-side, as the planner. */
  onPick: (trainerItemId: string) => void;
  /** The trainer being linked right now, so only that row spins. */
  picking: string | null;
  /**
   * Trainers already linked on the Monday item — read from Monday, not from our API,
   * which knows nothing about a relation it never wrote.
   */
  linkedTrainerIds: readonly string[];
  /**
   * False while the relation is unknown or unreadable. Picking then is refused, because
   * "we could not find out who is linked" must not behave like "nobody is linked".
   */
  canPick: boolean;
  /** Any generation-sensitive action is in flight; every control freezes. */
  busy: boolean;
  /** Set while the list is known to be superseded — the controls are frozen. */
  stale: boolean;
}

export const RecommendationTable = ({
  rows,
  names,
  phones,
  message,
  messageState,
  canViewFull,
  canPlan,
  sort,
  onApproachedChange,
  onPick,
  picking,
  linkedTrainerIds,
  canPick,
  busy,
  stale,
}: RecommendationTableProps) => {
  const sorted = sortRows(rows, sort);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>#</TableHead>
          <TableHead>Trainer</TableHead>
          {canViewFull && (
            <>
              <SortableHead sortKey="themeAvgScore" sort={sort}>
                Cijfer thema
              </SortableHead>
              <SortableHead sortKey="grade" sort={sort}>
                Cijfer totaal
              </SortableHead>
              <SortableHead sortKey="themeEvalCount" sort={sort} align="right">
                Evals thema
              </SortableHead>
              <SortableHead sortKey="totalEvalCount" sort={sort} align="right">
                Evals totaal
              </SortableHead>
              <SortableHead sortKey="timesTaught" sort={sort} align="right">
                Keer gegeven
              </SortableHead>
            </>
          )}
          <SortableHead sortKey="roundTripDurationMinutes" sort={sort}>
            Reistijd (retour)
          </SortableHead>
          {canViewFull && (
            <>
              <SortableHead sortKey="hourlyRateCents" sort={sort} align="right">
                Uurtarief
              </SortableHead>
              <SortableHead
                sortKey="trainerTravelCostCents"
                sort={sort}
                align="right"
              >
                Reiskosten
              </SortableHead>
              <SortableHead
                sortKey="travelMarginCents"
                sort={sort}
                align="right"
              >
                Reismarge
              </SortableHead>
              <SortableHead sortKey="totalCostCents" sort={sort} align="right">
                Totale kosten
              </SortableHead>
              <SortableHead
                sortKey="assignmentsThisMonth"
                sort={sort}
                align="right"
              >
                Opdr. deze maand
              </SortableHead>
              <SortableHead
                sortKey="assignmentsThisYear"
                sort={sort}
                align="right"
              >
                Opdr. dit jaar
              </SortableHead>
            </>
          )}
          <TableHead className="text-center">Benaderd</TableHead>
          {canPlan && <TableHead />}
          {canPlan && <TableHead>WhatsApp</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((row) => (
          <TrainerRow
            key={row.trainerItemId}
            row={row}
            name={names.get(row.trainerItemId) ?? null}
            phone={phones.get(row.trainerItemId) ?? null}
            message={message}
            messageState={messageState}
            canViewFull={canViewFull}
            canPlan={canPlan}
            onApproachedChange={onApproachedChange}
            onPick={onPick}
            picking={picking}
            linked={linkedTrainerIds.includes(row.trainerItemId)}
            canPick={canPick}
            busy={busy}
            stale={stale}
          />
        ))}
      </TableBody>
    </Table>
  );
};

interface SortableHeadProps {
  sortKey: SortKey;
  sort: readonly SortLevel[];
  align?: 'right';
  children: React.ReactNode;
}

/**
 * A header that shows its place in the chain, not just that it is "the" sort.
 *
 * With three levels active the planner has to be able to see WHICH is primary — an arrow
 * alone on three columns says nothing about their order, so the position number carries
 * that and the arrow carries direction.
 */
/**
 * A header that shows its place in the sort, but does not change it.
 *
 * All sorting lives in the Sort panel — priority is explicit and reorderable there,
 * where clicking headers could only ever imply it.
 */
const SortableHead = ({ sortKey, sort, align, children }: SortableHeadProps) => {
  const position = levelOf(sort, sortKey);
  const level = position === null ? null : sort[position - 1];
  const Arrow = level?.direction === 'desc' ? ArrowDown : ArrowUp;

  // `aria-sort` belongs on the column header rather than the button inside it (the
  // button role does not support it) — and on the PRIMARY column only. The attribute
  // names *the* sorted column, so marking all three of a chain tells assistive tech
  // there are three current sorts, which is worse than saying nothing. The secondary and
  // tertiary levels are announced as text instead.
  const isPrimary = position === 1;
  return (
    <TableHead
      aria-sort={
        !isPrimary || level === null
          ? 'none'
          : level.direction === 'asc'
            ? 'ascending'
            : 'descending'
      }
      className={cn(align === 'right' && 'text-right')}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1',
          // NOT `text-primary`: #0073EA on Monday's #191B32 is 3.73:1, under the 4.5:1
          // normal-text minimum. Buttons keep the action blue; small text gets a lighter one.
          position !== null && 'font-semibold text-[#0073EA] dark:text-[#77B8F5]'
        )}
      >
        {children}
        {level !== null && <Arrow className="size-3" aria-hidden />}
        {/* Only worth showing once more than one level is in play. */}
        {position !== null && sort.length > 1 && (
          <span className="text-[10px] font-normal tabular-nums" aria-hidden>
            {position}
          </span>
        )}
        {position !== null && !isPrimary && (
          <span className="sr-only">
            , sorteerniveau {position}, {level?.direction === 'asc' ? 'oplopend' : 'aflopend'}
          </span>
        )}
      </span>
    </TableHead>
  );
};

/**
 * A score, or "geen cijfers" — never a zero.
 *
 * The distinction this whole display layer exists for: an unevaluated trainer is unknown,
 * not bad, and rendering `0,0` would put them at the bottom of a column planners read as
 * quality.
 */
const ScoreCell = ({ value }: { value: number | null }) => (
  <TableCell className={cn(value === null && 'text-muted-foreground italic')}>
    {grade(value)}
  </TableCell>
);

/**
 * A count, or an em dash. "None recorded" and "zero" are different facts.
 *
 * `title` carries the per-theme breakdown on a multi-theme training: the cell shows the
 * highest figure, which never overstates but does hide the others.
 */
const CountCell = ({ value, title }: { value: number | null; title?: string | null }) => (
  <TableCell
    className={cn('text-right', value === null && 'text-muted-foreground')}
    title={title ?? undefined}
  >
    {value ?? '—'}
  </TableCell>
);

interface TrainerRowProps {
  row: Row;
  name: string | null;
  phone: string | null;
  message: string;
  messageState: MessageState;
  canViewFull: boolean;
  canPlan: boolean;
  onApproachedChange: (trainerItemId: string, approached: boolean) => void;
  onPick: (trainerItemId: string) => void;
  picking: string | null;
  linked: boolean;
  canPick: boolean;
  busy: boolean;
  stale: boolean;
}

const TrainerRow = ({
  row,
  name,
  phone,
  message,
  messageState,
  canViewFull,
  canPlan,
  onApproachedChange,
  onPick,
  picking,
  linked,
  canPick,
  busy,
  stale,
}: TrainerRowProps) => {
  const handleApproached = (checked: boolean | 'indeterminate'): void => {
    onApproachedChange(row.trainerItemId, checked === true);
  };

  const handlePick = (): void => {
    onPick(row.trainerItemId);
  };

  const isPicking = picking === row.trainerItemId;

  return (
    <TableRow
      // `bg-accent`, not `bg-primary-lighter` — the latter is a CSS variable this project
      // never registered with Tailwind, so it silently rendered nothing.
      className={cn(row.approached && 'text-muted-foreground', linked && 'bg-accent')}
    >
      <TableCell>{row.rank}</TableCell>
      <TableCell>
        <span className="flex items-center gap-2">
          {/* An id is an honest fallback: the list is still ranked and still correct. */}
          {name ?? <span className="text-muted-foreground">#{row.trainerItemId}</span>}
          {linked && (
            <span
              className="flex items-center gap-1 text-xs font-medium text-[#0073EA] dark:text-[#77B8F5]"
              title="Deze trainer is aan de training gekoppeld"
            >
              <Check className="size-3" />
              Gekoppeld
            </span>
          )}
        </span>
      </TableCell>
      {canViewFull && (
        <>
          <ScoreCell value={row.themeAvgScore ?? null} />
          <ScoreCell value={row.overallAverageDisplay ?? null} />
          <CountCell
            value={maxTheme(row, 'evaluationCount')}
            title={themeBreakdown(row, 'evaluationCount')}
          />
          <CountCell value={row.overallEvaluationCount ?? null} />
          <CountCell value={maxTheme(row, 'timesTaught')} title={themeBreakdown(row, 'timesTaught')} />
        </>
      )}
      <TableCell>{duration(row.roundTripDurationMinutes)}</TableCell>
      {canViewFull && (
        <>
          <TableCell className="text-right">{euros(row.hourlyRateCents)}</TableCell>
          <TableCell className="text-right">{euros(row.trainerTravelCostCents)}</TableCell>
          <TableCell className="text-right">{euros(travelMarginCents(row) ?? undefined)}</TableCell>
          <TableCell className="text-right font-medium">{euros(row.totalCostCents)}</TableCell>
          <CountCell value={row.assignmentsThisMonth ?? null} />
          <CountCell value={row.assignmentsThisYear ?? null} />
        </>
      )}
      <TableCell className="text-center">
        <Checkbox
          checked={row.approached}
          disabled={!canPlan || stale || busy}
          onCheckedChange={handleApproached}
          aria-label={`Benaderd: ${name ?? row.trainerItemId}`}
        />
      </TableCell>
      {canPlan && (
        <TableCell className="text-right">
          {/* Shown on `canPlan`, but that is presentation only: the write happens
              client-side as the logged-in user, so Monday's own column permission is
              what actually decides whether it lands. */}
          <Button
            size="sm"
            // The primary action on the row, so it gets Monday's action blue rather than
            // the near-black `secondary` our own dark palette resolves to.
            variant={linked ? 'ghost' : 'default'}
            onClick={handlePick}
            // `busy` covers a recalculate running alongside: it can advance the
            // generation between a pick's before- and after-checks, so both pass while
            // the trainer came from the superseded list.
            disabled={stale || busy || linked || !canPick}
            aria-label={`Kies ${name ?? row.trainerItemId}`}
          >
            {isPicking && <Loader2 className="mr-2 size-4 animate-spin" />}
            {linked ? 'Gekozen' : 'Kies'}
          </Button>
        </TableCell>
      )}
      {canPlan && (
        <TableCell>
          {/* Frozen alongside Kies and Benaderd: a superseded list may no longer
              recommend this trainer, and messaging one is not undoable. */}
          <WhatsappCell
            name={name}
            phone={phone}
            message={message}
            frozen={stale || busy}
            messageState={messageState}
          />
        </TableCell>
      )}
    </TableRow>
  );
};

/**
 * "Stuur WhatsApp" — the per-trainer deep link legacy Airtable had on every row.
 *
 * A real `<a href>` rather than a click handler, because a window opened after an `await`
 * is treated as a popup and blocked. That is why the message is loaded with the view
 * rather than on demand.
 *
 * Disabled — never hidden — when there is no number or no message yet: a missing button
 * reads as "this trainer cannot be messaged", where the truth is usually that nobody has
 * filled in their phone number on the Trainers board.
 */
/** Why a link is refused, in the planner's language. Keyed by state so none is forgotten. */
const MESSAGE_STATE_REASON: Record<Exclude<MessageState, 'ok'>, string> = {
  stale: 'De training is gewijzigd na dit bericht — open het WhatsApp-paneel en herlaad',
  error: 'Het bericht kon niet worden ververst — open het WhatsApp-paneel',
  pending: 'Het bericht wordt bijgewerkt — probeer het zo opnieuw',
  unreadable: 'Er staat een opgeslagen bericht dat niet gelezen kon worden — open het paneel',
  conflict: 'Een collega heeft dit bericht gewijzigd — open het paneel en kies welke versie geldt',
};

const WhatsappCell = ({
  name,
  phone,
  message,
  frozen,
  messageState,
}: {
  name: string | null;
  phone: string | null;
  message: string;
  /** The list is superseded or an action is in flight — see the call site. */
  frozen: boolean;
  /**
   * The panel shows these as a warning with a Herladen button; a row link has nowhere to
   * put a warning, and the text it would send is the old one. So here they disable.
   */
  messageState: MessageState;
}) => {
  const href = whatsappHref(phone, message, name);

  if (frozen || messageState !== 'ok' || href === null) {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled
        title={
          frozen
            ? 'De lijst is verouderd — ververs hem voordat je iemand benadert'
            : messageState !== 'ok'
              ? MESSAGE_STATE_REASON[messageState]
              : phone === null
                ? 'Geen telefoonnummer op het trainersbord'
                : 'Het bericht is nog niet geladen'
        }
      >
        <MessageCircle className="mr-2 size-4" />
        WhatsApp
      </Button>
    );
  }

  return (
    <Button size="sm" variant="outline" asChild>
      {/* `noreferrer` alongside `_blank`: without it the opened tab gets a handle back to
          this one via `window.opener`. */}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Stuur WhatsApp naar ${name ?? 'deze trainer'}`}
      >
        <MessageCircle className="mr-2 size-4" />
        WhatsApp
      </a>
    </Button>
  );
};
