import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SortPanel } from '../sort-panel';

import type { SortLevel } from '../sorting';

afterEach(cleanup);

const noop = (): void => undefined;

function renderPanel(sort: SortLevel[], onChange = vi.fn(), canViewFull = true) {
  render(
    <SortPanel sort={sort} onChange={onChange} canViewFull={canViewFull} onClose={noop} />
  );
  return onChange;
}

describe('SortPanel', () => {
  it('lists the chosen columns in priority order, numbered', () => {
    renderPanel([
      { key: 'totalCostCents', direction: 'asc' },
      { key: 'grade', direction: 'desc' },
    ]);

    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('Totale kosten');
    expect(items[0].textContent).toContain('1');
    expect(items[1].textContent).toContain('Cijfer totaal');
    expect(items[1].textContent).toContain('2');
  });

  it('adds a column at the end, the least important position', async () => {
    const onChange = renderPanel([{ key: 'totalCostCents', direction: 'asc' }]);

    await userEvent.click(screen.getByRole('button', { name: /Reismarge/ }));

    expect(onChange).toHaveBeenCalledWith([
      { key: 'totalCostCents', direction: 'asc' },
      { key: 'travelMarginCents', direction: 'desc' },
    ]);
  });

  /**
   * `laag → hoog` rather than an arrow: "ascending" on a money column and on a grade mean
   * opposite things to a planner, and the words say which.
   */
  it('offers both directions in words, starting at the column’s useful end', async () => {
    const onChange = renderPanel([{ key: 'totalCostCents', direction: 'asc' }]);

    const select = screen.getByLabelText('Richting voor Totale kosten');
    expect(select).toHaveProperty('value', 'asc');
    expect(screen.getByRole('option', { name: 'laag → hoog' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'hoog → laag' })).toBeDefined();

    await userEvent.selectOptions(select, 'desc');
    expect(onChange).toHaveBeenCalledWith([{ key: 'totalCostCents', direction: 'desc' }]);
  });

  /** Reordering keeps the direction — deleting and re-adding would lose it. */
  it('moves a level up the priority order', async () => {
    const onChange = renderPanel([
      { key: 'totalCostCents', direction: 'asc' },
      { key: 'grade', direction: 'desc' },
    ]);

    await userEvent.click(screen.getByRole('button', { name: /Cijfer totaal belangrijker/ }));

    expect(onChange).toHaveBeenCalledWith([
      { key: 'grade', direction: 'desc' },
      { key: 'totalCostCents', direction: 'asc' },
    ]);
  });

  it('cannot move the first level up or the last one down', () => {
    renderPanel([
      { key: 'totalCostCents', direction: 'asc' },
      { key: 'grade', direction: 'asc' },
    ]);

    expect(
      screen.getByRole('button', { name: /Totale kosten belangrijker/ }).hasAttribute('disabled')
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: /Cijfer totaal minder belangrijk/ }).hasAttribute('disabled')
    ).toBe(true);
  });

  it('removes a level', async () => {
    const onChange = renderPanel([{ key: 'grade', direction: 'asc' }]);

    await userEvent.click(screen.getByRole('button', { name: /Cijfer totaal verwijderen/ }));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('resets everything', async () => {
    const onChange = renderPanel([
      { key: 'grade', direction: 'asc' },
      { key: 'totalCostCents', direction: 'asc' },
    ]);

    await userEvent.click(screen.getByRole('button', { name: /Reset/ }));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('does not offer a column that is already in the chain', () => {
    renderPanel([{ key: 'grade', direction: 'asc' }]);

    // Present once, as a chosen level — not again in the add list.
    expect(screen.queryByRole('button', { name: /^Cijfer totaal$/ })).toBeNull();
  });

  /** A restricted caller has neither the money nor the score columns to sort on. */
  it('hides columns a restricted caller cannot see', () => {
    renderPanel([], vi.fn(), false);

    expect(screen.getByRole('button', { name: /Reistijd/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Totale kosten/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cijfer/ })).toBeNull();
  });

  /**
   * Every way out unmounts the focused element, and the browser then drops focus to
   * `document.body` — silently sending a keyboard user back to the top of the page
   * instead of to the button they opened.
   */
  describe('dismissal', () => {
    it('closes on Escape', async () => {
      const onClose = vi.fn();
      render(
        <SortPanel sort={[]} onChange={noop} canViewFull onClose={onClose} />
      );

      // From wherever focus happens to be inside the panel — the handler is on the
      // container, so the key bubbles to it.
      screen.getByRole('button', { name: 'Sluiten' }).focus();
      await userEvent.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalled();
    });

    it('closes on Sluiten', async () => {
      const onClose = vi.fn();
      render(<SortPanel sort={[]} onChange={noop} canViewFull onClose={onClose} />);

      await userEvent.click(screen.getByRole('button', { name: 'Sluiten' }));

      expect(onClose).toHaveBeenCalled();
    });
  });

  it('says so when nothing is sorted yet', () => {
    renderPanel([]);
    expect(screen.getByText(/Nog geen sortering/)).toBeDefined();
  });
});
