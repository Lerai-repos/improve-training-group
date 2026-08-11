import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecommendationsView } from '../recommendations-view';
import { fakeApi, fakeMonday, fakeWhatsapp, readyView, row } from './fakes';

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

    /**
     * The iframe only sees its own document, so a click on Monday's board around us
     * never reaches the mousedown listener. Losing window focus is the one signal we get
     * that the planner has moved on.
     */
    it('closes when the planner clicks out of the iframe entirely', async () => {
      renderView();
      await userEvent.click(screen.getByRole('button', { name: /Sorteren/ }));
      expect(screen.getByRole('dialog', { name: 'Sorteren' })).toBeDefined();

      await act(async () => {
        window.dispatchEvent(new Event('blur'));
        await Promise.resolve();
      });

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

describe('the WhatsApp panel', () => {
  const withWhatsapp = (options: Parameters<typeof fakeWhatsapp>[0] = {}) => ({
    ...fakeApi([readyView([row()])]),
    ...fakeWhatsapp(options),
  });

  const renderWith = (
    whatsappApi: ReturnType<typeof withWhatsapp>,
    overrides: Partial<UseRecommendationView> = {}
  ) => render(<RecommendationsView monday={monday} api={whatsappApi} view={view(overrides)} />);

  const openPanel = async (): Promise<void> => {
    await userEvent.click(screen.getByRole('button', { name: /WhatsApp-bericht/ }));
    await screen.findByRole('dialog', { name: 'WhatsApp-bericht' });
  };

  it('shows the generated message', async () => {
    renderWith(withWhatsapp());
    await openPanel();

    expect(await screen.findByDisplayValue(/Ben jij beschikbaar\?/)).toBeDefined();
  });

  /** Same corner, so two open popovers would overlap. */
  it('closes the sort panel when it opens, and vice versa', async () => {
    renderWith(withWhatsapp());

    await userEvent.click(screen.getByRole('button', { name: /Sorteren/ }));
    expect(screen.getByRole('dialog', { name: 'Sorteren' })).toBeDefined();

    await openPanel();
    expect(screen.queryByRole('dialog', { name: 'Sorteren' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Sorteren/ }));
    expect(screen.queryByRole('dialog', { name: 'WhatsApp-bericht' })).toBeNull();
  });

  it('closes on a click outside', async () => {
    renderWith(withWhatsapp());
    await openPanel();

    await userEvent.click(document.body);

    expect(screen.queryByRole('dialog', { name: 'WhatsApp-bericht' })).toBeNull();
  });

  /** The iframe never sees a click on Monday's own board around it. */
  it('closes when the planner leaves the iframe', async () => {
    renderWith(withWhatsapp());
    await openPanel();

    await act(async () => {
      window.dispatchEvent(new Event('blur'));
      await Promise.resolve();
    });

    expect(screen.queryByRole('dialog', { name: 'WhatsApp-bericht' })).toBeNull();
  });

  it('is hidden from a caller who may not plan', () => {
    renderWith(withWhatsapp(), {
      status: { kind: 'loaded', view: readyView([row()], true, false) },
    });

    expect(screen.queryByRole('button', { name: /WhatsApp-bericht/ })).toBeNull();
  });

  describe('copying', () => {
    afterEach(() => {
      Reflect.deleteProperty(navigator, 'clipboard');
    });

    it('uses the clipboard when the host allows it', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

      renderWith(withWhatsapp());
      await openPanel();
      await userEvent.click(screen.getByRole('button', { name: 'Kopieer' }));

      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Ben jij beschikbaar?'));
      expect(await screen.findByText('Gekopieerd.')).toBeDefined();
    });

    /**
     * Monday controls whether the iframe gets `clipboard-write`, so the refusal path is
     * not hypothetical — and it must end somewhere the planner can still act.
     */
    it('falls back to a selection when the clipboard is refused', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('blocked')) },
        configurable: true,
      });
      const execCommand = vi.fn(() => false);
      Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });

      renderWith(withWhatsapp());
      await openPanel();
      await userEvent.click(screen.getByRole('button', { name: 'Kopieer' }));

      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(await screen.findByText(/druk Ctrl\/⌘-C/)).toBeDefined();
    });
  });

  /**
   * The one place the error handling and the dismissal handling contradict each other:
   * closing anyway would unmount the message AND take the draft with it.
   */
  it('stays open when the closing save fails, keeping the draft and offering a way out', async () => {
    renderWith(withWhatsapp({ failSave: true }));
    await openPanel();

    const box = await screen.findByLabelText('Berichttekst');
    await userEvent.clear(box);
    await userEvent.type(box, 'mijn aantekening');
    await userEvent.click(screen.getByRole('button', { name: 'Sluiten' }));

    expect(await screen.findByText(/Niet opgeslagen/)).toBeDefined();
    expect(screen.getByRole('dialog', { name: 'WhatsApp-bericht' })).toBeDefined();
    expect(screen.getByDisplayValue('mijn aantekening')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Opnieuw proberen' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Herstel origineel' })).toBeDefined();
  });

  it('closes once the save succeeds', async () => {
    renderWith(withWhatsapp());
    await openPanel();

    const box = await screen.findByLabelText('Berichttekst');
    await userEvent.type(box, '!');
    await userEvent.click(screen.getByRole('button', { name: 'Sluiten' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'WhatsApp-bericht' })).toBeNull()
    );
  });

  /**
   * EVERY exit saves first. Routing only Sluiten and Escape through the guarded flush
   * left three other ways out — an outside click, losing the iframe's focus, and
   * pressing Sorteren — that hid a failed autosave and let the draft be overwritten.
   */
  describe('every way out', () => {
    const typeInto = async (): Promise<void> => {
      const box = await screen.findByLabelText('Berichttekst');
      await userEvent.clear(box);
      await userEvent.type(box, 'mijn aantekening');
    };

    it('saves a draft on a click outside', async () => {
      const api = withWhatsapp();
      renderWith(api);
      await openPanel();
      await typeInto();

      await userEvent.click(document.body);

      await waitFor(() => expect(api.calls.saves).toBeGreaterThan(0));
    });

    it('stays open on a click outside when the save fails', async () => {
      renderWith(withWhatsapp({ failSave: true }));
      await openPanel();
      await typeInto();

      await userEvent.click(document.body);

      expect(await screen.findByText(/Niet opgeslagen/)).toBeDefined();
      expect(screen.getByRole('dialog', { name: 'WhatsApp-bericht' })).toBeDefined();
      expect(screen.getByDisplayValue('mijn aantekening')).toBeDefined();
    });

    it('stays open when the iframe loses focus and the save fails', async () => {
      renderWith(withWhatsapp({ failSave: true }));
      await openPanel();
      await typeInto();

      await act(async () => {
        window.dispatchEvent(new Event('blur'));
        await Promise.resolve();
      });

      await waitFor(() => expect(screen.getByText(/Niet opgeslagen/)).toBeDefined());
      expect(screen.getByRole('dialog', { name: 'WhatsApp-bericht' })).toBeDefined();
    });

    /** Sorteren replaces the panel, so it is a dismissal like any other. */
    it('does not let Sorteren take over while a save is failing', async () => {
      renderWith(withWhatsapp({ failSave: true }));
      await openPanel();
      await typeInto();

      await userEvent.click(screen.getByRole('button', { name: /Sorteren/ }));

      expect(await screen.findByText(/Niet opgeslagen/)).toBeDefined();
      expect(screen.getByRole('dialog', { name: 'WhatsApp-bericht' })).toBeDefined();
      expect(screen.queryByRole('dialog', { name: 'Sorteren' })).toBeNull();
    });

    it('lets Sorteren through once the draft is saved', async () => {
      renderWith(withWhatsapp());
      await openPanel();
      await typeInto();

      await userEvent.click(screen.getByRole('button', { name: /Sorteren/ }));

      await waitFor(() => expect(screen.getByRole('dialog', { name: 'Sorteren' })).toBeDefined());
      expect(screen.queryByRole('dialog', { name: 'WhatsApp-bericht' })).toBeNull();
    });
  });
});
