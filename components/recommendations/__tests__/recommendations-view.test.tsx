import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { RecommendationsView } from '../recommendations-view';
import { fakeApi, fakeMonday, readyView, row } from './fakes';

import type { UseRecommendationView } from '../use-recommendation-view';

afterEach(() => {
  cleanup();
  document.documentElement.className = '';
  localStorage.clear();
});

const monday = fakeMonday();
const api = fakeApi([readyView([row()])]);

function view(overrides: Partial<UseRecommendationView> = {}): UseRecommendationView {
  return {
    itemId: '111',
    theme: 'light',
    status: { kind: 'loaded', view: readyView([row()]) },
    recalculating: false,
    recalculate: () => Promise.resolve(),
    setApproached: () => Promise.resolve(),
    pick: () => Promise.resolve(),
    picking: null,
    busy: false,
    linked: { kind: 'ready', trainerItemIds: [] },
    refresh: () => Promise.resolve(),
    reset: () => Promise.resolve(),
    stale: false,
    warning: null,
    dismissWarning: () => undefined,
    ...overrides,
  };
}

const renderView = (overrides: Partial<UseRecommendationView> = {}) =>
  render(<RecommendationsView monday={monday} api={api} view={view(overrides)} />);

describe('RecommendationsView', () => {
  describe('Monday’s theme', () => {
    /**
     * Scoped to this container, never to the shared `next-themes` preference. That one
     * is persisted to local storage and shared across the origin, so writing it would
     * change the user's theme in every other tab for as long as the iframe is open — and
     * a storage event from one of those tabs could flip the iframe back mid-session.
     */
    it('darkens its own container and nothing else', () => {
      const { container } = renderView({ theme: 'dark' });

      expect(container.firstElementChild?.classList.contains('dark')).toBe(true);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(localStorage.getItem('theme')).toBeNull();
    });

    it('leaves the container light for a light workspace', () => {
      const { container } = renderView({ theme: 'light' });
      expect(container.firstElementChild?.classList.contains('dark')).toBe(false);
    });

    /**
     * Nothing is painted until Monday says which theme it is.
     *
     * Guessing light is what produced the white flash in a dark workspace: the browser
     * paints the iframe, our page paints white again while `get('context')` is in
     * flight, and only then does the real colour arrive. Transparent lets the host's own
     * backdrop show through for that moment instead.
     */
    it('paints no background before the context has arrived', () => {
      const { container } = renderView({ theme: null });
      const root = container.firstElementChild;

      expect(root?.classList.contains('dark')).toBe(false);
      expect(root?.classList.contains('bg-transparent')).toBe(true);
      expect(root?.classList.contains('bg-background')).toBe(false);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });

    /**
     * A transparent background was only half of it: the heading and the outline Sort
     * button carry their own light tokens, so a dark workspace still got a pale flash.
     * Nothing renders until Monday says which theme it is.
     */
    it('renders nothing at all before the context has arrived', () => {
      renderView({ theme: null });

      expect(screen.queryByText('Aanbevolen trainers')).toBeNull();
      expect(screen.queryByRole('button', { name: /Sorteren/ })).toBeNull();
    });

    /**
     * A context failure means we will never learn the theme — so unlike `pending`, this
     * is not a moment that passes. Showing the normal view would leave a light-token
     * header and a working Sort button over a dark workspace permanently, above a list
     * that cannot load.
     */
    describe('when the context never arrives', () => {
      const failed = { theme: null, status: { kind: 'error' as const, message: 'geen context' } };

      it('says what went wrong', () => {
        renderView(failed);
        expect(screen.getByText(/geen context/)).toBeDefined();
        expect(screen.getByText(/konden niet worden geladen/)).toBeDefined();
      });

      it('shows no toolbar to click', () => {
        renderView(failed);

        expect(screen.queryByRole('button', { name: /Sorteren/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /Opnieuw berekenen/ })).toBeNull();
        expect(screen.queryByText('Aanbevolen trainers')).toBeNull();
      });

      /** Its own opaque surface, since neither theme's tokens can be trusted here. */
      it('does not rely on the theme tokens it never received', () => {
        const { container } = renderView(failed);
        const root = container.firstElementChild;

        expect(root?.classList.contains('monday-surface')).toBe(false);
        expect(root?.classList.contains('bg-background')).toBe(false);
      });
    });

    it('paints its own background once the theme is known', () => {
      const { container } = renderView({ theme: 'dark' });
      expect(container.firstElementChild?.classList.contains('bg-background')).toBe(true);
    });
  });

  describe('the live trainer relation', () => {
    it('names the linked trainer even when the list no longer contains them', () => {
      renderView({
        // The recommendation rows are for someone else entirely — a recalculate can
        // drop the linked trainer, and they must still be visible.
        status: { kind: 'loaded', view: readyView([row({ trainerItemId: '901' })]) },
        linked: { kind: 'ready', trainerItemIds: ['900'] },
      });

      expect(screen.getByText(/Gekoppeld aan deze training/)).toBeDefined();
    });

    /** "We could not find out" must not read as "nobody is linked". */
    it('explains why picking is disabled when the relation cannot be read', () => {
      renderView({ linked: { kind: 'error', message: 'viewers cannot call the API' } });

      expect(screen.getByText(/kon niet worden gelezen/)).toBeDefined();
    });

    it('says nothing when nobody is linked', () => {
      renderView({ linked: { kind: 'ready', trainerItemIds: [] } });
      expect(screen.queryByText(/Gekoppeld aan deze training/)).toBeNull();
    });
  });

  describe('a superseded list', () => {
    /**
     * The warning tells the planner to refresh, so something on screen has to be able
     * to. Without it the controls stay frozen until the iframe is reopened.
     */
    it('offers a way out', () => {
      renderView({ stale: true, warning: 'Deze lijst is verouderd.' });
      expect(screen.getByRole('button', { name: 'Ververs lijst' })).toBeDefined();
    });
  });

  describe('the sort panel', () => {
    it('opens from the button and closes on a click outside', async () => {
      renderView();

      await userEvent.click(screen.getByRole('button', { name: /Sorteren/ }));
      expect(screen.getByRole('dialog', { name: 'Sorteren' })).toBeDefined();

      // Anywhere else on the page — the behaviour every dropdown has.
      await userEvent.click(document.body);

      expect(screen.queryByRole('dialog', { name: 'Sorteren' })).toBeNull();
    });

    /**
     * Recalculate sits next to the trigger but is not part of it. Counting it as
     * "inside" would leave the panel hanging open over a list that is about to be
     * replaced.
     */
    it('closes when an adjacent action is used', async () => {
      renderView();
      await userEvent.click(screen.getByRole('button', { name: /Sorteren/ }));
      expect(screen.getByRole('dialog', { name: 'Sorteren' })).toBeDefined();

      await userEvent.click(screen.getByRole('button', { name: /Opnieuw berekenen/ }));

      expect(screen.queryByRole('dialog', { name: 'Sorteren' })).toBeNull();
    });

    it('stays open while the planner works inside it', async () => {
      renderView();
      await userEvent.click(screen.getByRole('button', { name: /Sorteren/ }));

      await userEvent.click(screen.getByRole('button', { name: /Totale kosten/ }));

      expect(screen.getByRole('dialog', { name: 'Sorteren' })).toBeDefined();
    });

    /** No default chain: the list arrives in the engine's own order. */
    it('starts with nothing sorted', async () => {
      renderView();
      await userEvent.click(screen.getByRole('button', { name: /Sorteren/ }));

      expect(screen.getByText(/Nog geen sortering/)).toBeDefined();
    });
  });

  it('hides Recalculate from a caller who may not plan', () => {
    renderView({
      status: { kind: 'loaded', view: readyView([row()], true, false) },
    });
    expect(screen.queryByRole('button', { name: /Opnieuw berekenen/ })).toBeNull();
  });
});
