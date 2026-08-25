import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { Segmented } from '../segmented';

afterEach(cleanup);

/**
 * De keuzeknoppen van de checklist.
 *
 * Er wordt hier één ding getest dat je op het scherm niet ziet: hoe vaak een klik doorkomt.
 * Een radio die nog niet gekozen is vuurt `click` én `change`, een die dat al is alleen
 * `click` — en de acteurvraag hééft die tweede nodig, want hij staat voorgezet op wat Monday
 * suggereert en bevestigen is dan een klik zonder wijziging.
 */

const OPTIES = [
  { value: 'ja' as const, label: 'Ja' },
  { value: 'nee' as const, label: 'Nee' },
];

describe('Segmented', () => {
  it('stuurt een echte wijziging precies één keer door', async () => {
    const user = userEvent.setup();
    const gezien: string[] = [];
    render(
      <Segmented
        name="acteur"
        value="nee"
        options={OPTIES}
        onChange={(next) => gezien.push(next)}
      />
    );

    await user.click(screen.getByText('Ja'));

    // Twee keer zou twee toestandswijzigingen en twee opslagen kosten voor één klik.
    expect(gezien).toEqual(['ja']);
  });

  /**
   * De reden dat `onClick` er überhaupt is. Zonder deze klik zou bevestigen van Monday's
   * voorstel niets doen, en blijft de acteurvraag onbeantwoord terwijl de adviseur hem net
   * beantwoord heeft.
   */
  it('stuurt het bevestigen van de al gekozen knop ook door', async () => {
    const user = userEvent.setup();
    const gezien: string[] = [];
    render(
      <Segmented
        name="acteur"
        value="nee"
        options={OPTIES}
        onChange={(next) => gezien.push(next)}
      />
    );

    await user.click(screen.getByText('Nee'));

    expect(gezien).toEqual(['nee']);
  });

  it('werkt net zo met drie opties', async () => {
    const user = userEvent.setup();
    const gezien: string[] = [];
    render(
      <Segmented
        name="groepkeuze"
        value="geen"
        options={[
          { value: 'geen', label: 'Niet van toepassing' },
          { value: 'eigen', label: 'Ieder een eigen groep' },
          { value: 'samen', label: 'Samen op één groep' },
        ]}
        onChange={(next) => gezien.push(next)}
      />
    );

    await user.click(screen.getByText('Samen op één groep'));
    await user.click(screen.getByText('Ieder een eigen groep'));

    expect(gezien).toEqual(['samen', 'eigen']);
  });
});
