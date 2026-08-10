import { cleanup, render, screen } from '@testing-library/react';
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

    /** Nothing is applied until Monday says which theme it is — no guessed default. */
    it('applies nothing before the context has arrived', () => {
      const { container } = renderView({ theme: null });

      expect(container.firstElementChild?.classList.contains('dark')).toBe(false);
      expect(document.documentElement.classList.contains('dark')).toBe(false);
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

  it('hides Recalculate from a caller who may not plan', () => {
    renderView({
      status: { kind: 'loaded', view: readyView([row()], true, false) },
    });
    expect(screen.queryByRole('button', { name: /Opnieuw berekenen/ })).toBeNull();
  });
});
