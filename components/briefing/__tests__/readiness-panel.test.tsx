import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ReadinessPanel } from '../readiness-panel';

import type { TabIssue } from '@lib/briefing/tab';

afterEach(cleanup);

/**
 * Het overzicht bovenaan de tab. Eén label moet in een oogopslag zeggen waar de briefing
 * staat, en de lijst eronder precies wat eraan te doen is.
 */

const blokkade: TabIssue = {
  kind: 'geen_lead',
  tekst: 'Er staat niemand in de kolom Trainers contactgegevens',
  blokkeert: true,
};
const leeg: TabIssue = {
  kind: 'veld_leeg',
  tekst: 'Locatie is leeg; dat wordt een zichtbare regel in het document',
  blokkeert: false,
};

describe('ReadinessPanel', () => {
  it('toont Compleet en geen lijst als er niets mist', () => {
    render(<ReadinessPanel gereedheid={{ compleet: true, blokkeert: [], ontbreekt: [] }} />);
    expect(screen.getByText('Compleet')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('zegt dat genereren niet kan zolang er iets blokkeert, en zet de blokkade bovenaan', () => {
    render(
      <ReadinessPanel gereedheid={{ compleet: false, blokkeert: [blokkade], ontbreekt: [leeg] }} />
    );
    expect(screen.getByText('Kan niet genereren')).toBeTruthy();
    const regels = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(regels).toEqual([blokkade.tekst, leeg.tekst]);
  });

  it('noemt alleen ontbrekende velden "nog niet compleet", niet blokkerend', () => {
    render(<ReadinessPanel gereedheid={{ compleet: false, blokkeert: [], ontbreekt: [leeg] }} />);
    expect(screen.getByText('Nog niet compleet')).toBeTruthy();
    expect(screen.queryByText('Kan niet genereren')).toBeNull();
  });
});
