import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { ReadinessPanel } from '../readiness-panel';

import type { TabControle } from '@lib/briefing/tab';

afterEach(cleanup);

/**
 * De checklist bovenaan de tab: korte regels met een vinkje, de uitleg pas bij een klik.
 */

const blokkade: TabControle = {
  key: 'lead',
  label: 'Leadtrainer',
  status: 'blokkeert',
  uitleg: 'Zet er één trainer in.',
};
const leeg: TabControle = {
  key: 'datum',
  label: 'Datum',
  status: 'ontbreekt',
  uitleg: 'De kolom Datum is leeg.',
};
const goed: TabControle = { key: 'locatie', label: 'Locatie', status: 'ok', uitleg: 'Utrecht' };

describe('ReadinessPanel', () => {
  it('toont Compleet als alles klopt, en nog steeds de regels met een vinkje', () => {
    render(<ReadinessPanel gereedheid={{ compleet: true, controles: [goed] }} />);
    expect(screen.getByText('Compleet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Locatie' })).toBeTruthy();
  });

  it('zegt dat genereren niet kan zolang er iets blokkeert', () => {
    render(<ReadinessPanel gereedheid={{ compleet: false, controles: [blokkade, leeg, goed] }} />);
    expect(screen.getByText('Kan niet genereren')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Leadtrainer',
      'Datum',
      'Locatie',
    ]);
  });

  it('verdeelt de regels over twee losse lijsten, zodat openklappen de buurkolom niet verschuift', () => {
    render(<ReadinessPanel gereedheid={{ compleet: false, controles: [blokkade, leeg, goed] }} />);
    const lijsten = screen.getAllByRole('list');
    expect(lijsten.map((lijst) => lijst.querySelectorAll('button').length)).toEqual([2, 1]);
  });

  it('noemt alleen ontbrekende punten "nog niet compleet"', () => {
    render(<ReadinessPanel gereedheid={{ compleet: false, controles: [leeg, goed] }} />);
    expect(screen.getByText('Nog niet compleet')).toBeTruthy();
  });

  it('klapt de uitleg open en weer dicht bij een klik', async () => {
    const user = userEvent.setup();
    render(<ReadinessPanel gereedheid={{ compleet: false, controles: [leeg] }} />);
    const regel = screen.getByRole('button', { name: 'Datum' });

    expect(regel.getAttribute('aria-expanded')).toBe('false');
    await user.click(regel);
    expect(regel.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('De kolom Datum is leeg.')).toBeTruthy();
    await user.click(regel);
    expect(regel.getAttribute('aria-expanded')).toBe('false');
  });
});
