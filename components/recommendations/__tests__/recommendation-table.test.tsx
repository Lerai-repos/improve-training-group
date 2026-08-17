import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecommendationTable } from '../recommendation-table';
import { restrictedRow, row } from './fakes';

afterEach(cleanup);

const NAMES = new Map([
  ['900', 'Sanne de Vries'],
  ['901', 'Joris Bakker'],
]);

const PHONES = new Map([['900', '0611771540']]);

/** The generated opening line, so the personalised greeting is exercised for real. */
const MESSAGE = 'Ben jij beschikbaar?\n\n07-10-2026\nTimemanagement';

const noop = (): void => undefined;

function renderTable(props: Partial<Parameters<typeof RecommendationTable>[0]> = {}) {
  return render(
    <RecommendationTable
      rows={[row()]}
      names={NAMES}
      phones={PHONES}
      message={MESSAGE}
      messageState="ok"
      canViewFull
      canPlan
      sort={[]}
      onApproachedChange={noop}
      onPick={noop}
      picking={null}
      linkedTrainerIds={[]}
      canPick
      busy={false}
      stale={false}
      {...props}
    />
  );
}

describe('RecommendationTable', () => {
  it('resolves names client-side, so no name is ever stored server-side', () => {
    renderTable();
    expect(screen.getByText('Sanne de Vries')).toBeDefined();
  });

  /**
   * A failed name lookup must not empty the table. Monday viewers reportedly cannot call
   * the API at all, and for them this fallback is the whole experience — ugly, but still
   * ranked and still correct.
   */
  it('falls back to the item id when a name is missing', () => {
    renderTable({ names: new Map() });
    expect(screen.getByText('#900')).toBeDefined();
  });

  /**
   * The failure this whole DTO split exists to prevent. `trainerOverallAvg` returns 0,
   * not null, for a trainer with no evaluations — rendering that would put a newly
   * qualified trainer at the bottom of the column planners read as quality.
   */
  it('shows "geen cijfers" rather than a zero for an unevaluated trainer', () => {
    renderTable({ rows: [row({ overallAverageDisplay: null, themeAvgScore: null })] });

    // Both score columns — theme and overall — and neither may render a zero.
    expect(screen.getAllByText('geen cijfers')).toHaveLength(2);
    expect(screen.queryByText('0,0')).toBeNull();
  });

  /**
   * Legacy "Opdrachten deze maand / dit jaar" — how much the trainer already has on in
   * the month and year of THIS training. A real 0 is meaningful (nothing booked) and
   * must not render as the em dash that means "not recorded".
   */
  it('shows workload counts, with zero distinct from unknown', () => {
    renderTable({
      rows: [
        row({ trainerItemId: '900', assignmentsThisMonth: 0, assignmentsThisYear: 31 }),
        row({ trainerItemId: '901', rank: 2, assignmentsThisMonth: null, assignmentsThisYear: null }),
      ],
    });

    const [busy, unknown] = screen.getAllByRole('row').slice(1);
    expect(busy.textContent).toContain('31');
    expect(within(busy).getAllByText('0').length).toBeGreaterThan(0);
    expect(within(unknown).getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  /** Counts are em-dashed when absent: "none recorded" is not "zero". */
  it('em-dashes the evaluation counts until phase 3 fills them', () => {
    renderTable({
      rows: [row({ overallEvaluationCount: null, themes: [] })],
    });
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  /**
   * Legacy Airtable's "Travel Profit Margin": what the client is charged for travel minus
   * what the trainer's travel costs us. Both halves were already stored — nothing ever
   * subtracted them.
   */
  /**
   * The cents are asserted deliberately. Rounded to whole euros this margin renders as
   * `€ 10` — the same as €9,50 and €10,49 — on the one column where the values sit near
   * zero and planners sort by them.
   */
  it('shows the travel margin to the cent, derived from figures already in the row', () => {
    renderTable({
      rows: [row({ clientTravelChargeCents: 2_549, trainerTravelCostCents: 1_500 })],
    });
    expect(screen.getByText('€ 10,49')).toBeDefined();
  });

  it('shows a real average when there is one', () => {
    renderTable({ rows: [row({ overallAverageDisplay: 8.35, overallEvaluationCount: 12 })] });
    expect(screen.getByText('8,4')).toBeDefined();
  });

  describe('the restricted payload', () => {
    /**
     * Not a hidden column — the fields are absent from the response entirely. The table
     * must render a coherent list from what it was given rather than a row of dashes.
     */
    it('renders no monetary column at all', () => {
      renderTable({ rows: [restrictedRow()], canViewFull: false });

      const table = screen.getByRole('table');
      expect(within(table).queryByText('Totale kosten')).toBeNull();
      expect(within(table).queryByText('Uurtarief')).toBeNull();
      expect(within(table).queryByText('Reismarge')).toBeNull();
      expect(within(table).queryByText('Cijfer totaal')).toBeNull();
      expect(within(table).queryByText('Keer gegeven')).toBeNull();
      // Workload is internal planning data, so it stays out of the restricted payload.
      expect(within(table).queryByText('Opdr. dit jaar')).toBeNull();
      // …while what a restricted caller DOES get is still there.
      expect(within(table).getByText('Reistijd (retour)')).toBeDefined();
      expect(within(table).getByText('Sanne de Vries')).toBeDefined();
    });

    it('never renders a euro amount, even a zero one', () => {
      renderTable({ rows: [restrictedRow()], canViewFull: false });
      expect(screen.getByRole('table').textContent).not.toMatch(/€/);
    });
  });

  describe('the Benaderd control', () => {
    it('is disabled for a caller who may not plan', () => {
      renderTable({ canPlan: false });
      expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(true);
    });

    it('is disabled while the list is known to be superseded', () => {
      renderTable({ stale: true });
      expect(screen.getByRole('checkbox').hasAttribute('disabled')).toBe(true);
    });
  });

  describe('the Pick control', () => {
    /**
     * Shown on `canPlan` — but that is presentation only. The write happens client-side
     * as the logged-in user, so Monday's own column permission is what actually decides
     * whether it lands.
     */
    it('is absent for a caller who may not plan', () => {
      renderTable({ canPlan: false });
      expect(screen.queryByRole('button', { name: /^Kies/ })).toBeNull();
    });

    it('links the trainer it belongs to', async () => {
      const onPick = vi.fn();
      renderTable({ onPick });

      await userEvent.click(screen.getByRole('button', { name: /^Kies/ }));

      expect(onPick).toHaveBeenCalledWith('900');
    });

    /**
     * Frozen once the list is superseded. Acting on it would link a trainer chosen from
     * a ranking nobody else can see any more.
     */
    it('is disabled while the list is stale', () => {
      renderTable({ stale: true });
      expect(screen.getByRole('button', { name: /^Kies/ }).hasAttribute('disabled')).toBe(true);
    });

    /**
     * One generation-sensitive action at a time. A recalculate running alongside a pick
     * can advance the generation between the pick's before- and after-checks, so both
     * pass while the trainer being linked came from the superseded list.
     */
    it('disables every row while anything is in flight', () => {
      renderTable({
        rows: [row({ trainerItemId: '900' }), row({ trainerItemId: '901', rank: 2 })],
        picking: '900',
        busy: true,
      });

      const buttons = screen.getAllByRole('button', { name: /^Kies/ });
      expect(buttons).toHaveLength(2);
      expect(buttons.every((b) => b.hasAttribute('disabled'))).toBe(true);
      // …including Benaderd, which also targets a generation.
      expect(screen.getAllByRole('checkbox').every((c) => c.hasAttribute('disabled'))).toBe(true);
    });
  });

  /**
   * Read from Monday, not from our API — which knows nothing about a relation it never
   * wrote. Without it the view offers "Kies" on every row forever, with nothing to say
   * one of them is already the answer, so a second click silently replaces a
   * colleague's choice.
   */
  describe('the trainer already linked to the training', () => {
    it('is marked, and cannot be picked again', () => {
      renderTable({
        rows: [row({ trainerItemId: '900' }), row({ trainerItemId: '901', rank: 2 })],
        linkedTrainerIds: ['900'],
      });

      expect(screen.getByText('Gekoppeld')).toBeDefined();

      const chosen = screen.getByRole('button', { name: 'Kies Sanne de Vries' });
      expect(chosen.hasAttribute('disabled')).toBe(true);
      expect(chosen.textContent).toContain('Gekozen');

      // The others stay available — a planner may still change their mind.
      expect(
        screen.getByRole('button', { name: 'Kies Joris Bakker' }).hasAttribute('disabled')
      ).toBe(false);
    });

    it('marks nothing when the relation is empty', () => {
      renderTable({ linkedTrainerIds: [] });
      expect(screen.queryByText('Gekoppeld')).toBeNull();
    });

    it('reports the trainer and the new value', async () => {
      const onApproachedChange = vi.fn();
      renderTable({ onApproachedChange });

      await userEvent.click(screen.getByRole('checkbox'));

      expect(onApproachedChange).toHaveBeenCalledWith('900', true);
    });
  });

  /**
   * The chain has to be legible: with three levels active, an arrow on three columns
   * says nothing about which is primary. The number carries the order, the arrow the
   * direction.
   */
  it('shows the chain position once more than one column is sorting', async () => {
    renderTable({
      sort: [
        { key: 'totalCostCents', direction: 'asc' },
        { key: 'grade', direction: 'desc' },
      ],
    });

    expect(screen.getByText('Totale kosten').textContent).toContain('1');
    expect(screen.getByText('Cijfer totaal').textContent).toContain('2');

    // A single level needs no numbering — it would just be noise.
    cleanup();
    renderTable({ sort: [{ key: 'totalCostCents', direction: 'asc' }] });
    expect(screen.getByText('Totale kosten').textContent).not.toContain('1');
  });



  describe('sorting', () => {
    const rows = [
      row({ trainerItemId: '900', rank: 1, totalCostCents: 35_100, overallAverageDisplay: null }),
      row({ trainerItemId: '901', rank: 2, totalCostCents: 20_000, overallAverageDisplay: 7.2 }),
    ];

    const names = (): string[] =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((tr) => tr.children[1].textContent ?? '');

    /** No chain at all: the engine's own ranking, which is what Reset returns to. */
    it('falls back to the recommended order when nothing is sorted', () => {
      renderTable({ rows });
      expect(names()).toEqual(['Sanne de Vries', 'Joris Bakker']);
    });

    it('sorts by total cost when asked', () => {
      renderTable({ rows, sort: [{ key: 'totalCostCents', direction: 'asc' }] });
      expect(names()).toEqual(['Joris Bakker', 'Sanne de Vries']);
    });

    /** "No grades" is unknown, not worst — it sorts last rather than as a zero. */
    it('puts trainers without grades last, not first', () => {
      renderTable({ rows, sort: [{ key: 'grade', direction: 'desc' }] });
      expect(names()).toEqual(['Joris Bakker', 'Sanne de Vries']);
    });
  });

  /**
   * The per-row deep link legacy Airtable had, which Peter asked after by name. One shared
   * message, one recipient per row.
   */
  describe('the WhatsApp link', () => {
    const link = (name: string) =>
      screen.getByRole('link', { name: `Stuur WhatsApp naar ${name}` });

    it('addresses the message to that row’s trainer', () => {
      renderTable();

      expect(link('Sanne de Vries').getAttribute('href')).toBe(
        'https://wa.me/31611771540?text=Hey%20Sanne%2C%20ben%20jij%20beschikbaar%3F%0A%0A07-10-2026%0ATimemanagement'
      );
    });

    /** A real anchor, not a handler: a window opened after an await is blocked. */
    it('opens in a new tab without handing it a window.opener', () => {
      renderTable();

      const anchor = link('Sanne de Vries');
      expect(anchor.getAttribute('target')).toBe('_blank');
      expect(anchor.getAttribute('rel')).toContain('noopener');
    });

    /**
     * Disabled rather than absent. A missing button reads as "this trainer cannot be
     * messaged"; the truth is that nobody filled in their number.
     */
    it('disables the button for a trainer with no phone number', () => {
      renderTable({ rows: [row({ trainerItemId: '901' })] });

      expect(screen.queryByRole('link', { name: /Stuur WhatsApp/ })).toBeNull();
      const button = screen.getByRole('button', { name: /WhatsApp/ });
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(button.getAttribute('title')).toMatch(/telefoonnummer/i);
    });

    /** The message arrives with its own fetch; until then there is nothing to send. */
    it('disables the button until the message has loaded', () => {
      renderTable({ message: '' });

      expect(screen.getByRole('button', { name: /WhatsApp/ }).hasAttribute('disabled')).toBe(true);
    });

    /** Same rule as every other planning control. */
    it('is not offered to a caller who cannot plan', () => {
      renderTable({ canPlan: false });

      expect(screen.queryByRole('link', { name: /Stuur WhatsApp/ })).toBeNull();
    });

    /**
     * The panel warns and offers Herladen; a row link has nowhere to put a warning, and
     * the text it would send still carries the old date or location.
     */
    it('is disabled when the saved message predates a change to the training', () => {
      renderTable({ messageState: 'stale' });

      expect(screen.queryByRole('link', { name: /Stuur WhatsApp/ })).toBeNull();
      expect(screen.getByRole('button', { name: /WhatsApp/ }).getAttribute('title')).toMatch(
        /gewijzigd/i
      );
    });

    /**
     * A refresh that failed leaves the PREVIOUS message in hand, and nothing re-reads it
     * until the panel is opened — so on a freshly recalculated list every link would send
     * the old date.
     */
    it('is disabled when the last refresh failed', () => {
      renderTable({ messageState: 'error' });

      expect(screen.queryByRole('link', { name: /Stuur WhatsApp/ })).toBeNull();
      expect(screen.getByRole('button', { name: /WhatsApp/ }).getAttribute('title')).toMatch(
        /ververst/i
      );
    });

    /**
     * A new generation renders immediately while its message GET is still in flight, so
     * for that window the list is new and the text is not. Same for a refresh deferred
     * behind an unsaved draft.
     */
    it('is disabled while a refresh has not been read yet', () => {
      renderTable({ messageState: 'pending' });

      expect(screen.queryByRole('link', { name: /Stuur WhatsApp/ })).toBeNull();
      expect(screen.getByRole('button', { name: /WhatsApp/ }).getAttribute('title')).toMatch(
        /bijgewerkt/i
      );
    });

    /** A colleague's edit is waiting to be resolved; this text is the losing version. */
    it('is disabled while the message has a save conflict', () => {
      renderTable({ messageState: 'conflict' });

      expect(screen.queryByRole('link', { name: /Stuur WhatsApp/ })).toBeNull();
      expect(screen.getByRole('button', { name: /WhatsApp/ }).getAttribute('title')).toMatch(
        /collega/i
      );
    });

    /** The generated fallback would quietly discard whatever a colleague saved. */
    it('is disabled when a saved edit could not be read', () => {
      renderTable({ messageState: 'unreadable' });

      expect(screen.queryByRole('link', { name: /Stuur WhatsApp/ })).toBeNull();
    });

    /**
     * Frozen alongside Kies and Benaderd. A superseded list may no longer recommend this
     * trainer, and unlike a pick, a sent message cannot be taken back.
     */
    it.each([
      ['stale', { stale: true }],
      ['busy', { busy: true }],
    ])('is disabled while the list is %s', (_label, props) => {
      renderTable(props);

      expect(screen.queryByRole('link', { name: /Stuur WhatsApp/ })).toBeNull();
      const button = screen.getByRole('button', { name: /WhatsApp/ });
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(button.getAttribute('title')).toMatch(/verouderd/i);
    });
  });
});
