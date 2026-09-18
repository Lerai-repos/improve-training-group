import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CyclusPanel } from '../cyclus-panel';

import type { CyclusOptie } from '@lib/briefing/types';

afterEach(cleanup);

/**
 * De vraag of deze sessies samen één briefing krijgen.
 *
 * Het gaat hier om wat de adviseur moet kunnen: zien wat er voorgesteld wordt én waarom een
 * sessie er niet bij staat, het voorstel overrulen, en "dit is geen cyclus" antwoorden zonder
 * dat dat als "nog niet beantwoord" terugkomt.
 */

const optie = (over: Partial<CyclusOptie> & { itemId: string }): CyclusOptie => ({
  datum: '2026-09-22',
  klanttitel: 'Navigating difficult conversations',
  trainers: 'Isabelle Zwetsloot',
  huidig: false,
  aangevinkt: true,
  voorgesteld: true,
  reden: null,
  ...over,
});

const OPTIES = [
  optie({ itemId: '900', huidig: true }),
  optie({ itemId: '901', datum: '2027-01-04' }),
];

describe('CyclusPanel', () => {
  it('toont de sessies met datum, klanttitel en trainers', () => {
    render(
      <CyclusPanel
        keuze={{ opties: OPTIES, openstaand: true }}
        bezig={false}
        fout={null}
        onBevestig={vi.fn()}
      />
    );

    expect(screen.getByText(/22 september 2026/)).toBeTruthy();
    expect(screen.getByText(/4 januari 2027/)).toBeTruthy();
    expect(screen.getAllByText(/Isabelle Zwetsloot/)).toHaveLength(2);
    expect(screen.getByText(/Eén cyclus van 2 sessies/)).toBeTruthy();
  });

  /** De training zelf hoort er per definitie bij; uitvinken zou nergens over gaan. */
  it('laat deze training zelf niet uitvinken', () => {
    render(
      <CyclusPanel
        keuze={{ opties: OPTIES, openstaand: true }}
        bezig={false}
        fout={null}
        onBevestig={vi.fn()}
      />
    );

    expect(screen.getByLabelText(/deze training/).getAttribute('disabled')).not.toBeNull();
  });

  it('stuurt de aangevinkte sessies mee bij het bevestigen', () => {
    const onBevestig = vi.fn();
    render(
      <CyclusPanel
        keuze={{ opties: OPTIES, openstaand: true }}
        bezig={false}
        fout={null}
        onBevestig={onBevestig}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Bevestigen' }));

    expect(onBevestig).toHaveBeenCalledWith(['900', '901'], ['900', '901']);
  });

  /** Alles uit op deze training na is een antwoord: "geen cyclus", en dus een lege lijst. */
  it('stuurt een lege lijst als alleen deze training overblijft', () => {
    const onBevestig = vi.fn();
    render(
      <CyclusPanel
        keuze={{ opties: OPTIES, openstaand: true }}
        bezig={false}
        fout={null}
        onBevestig={onBevestig}
      />
    );

    fireEvent.click(screen.getByLabelText(/4 januari 2027/));
    fireEvent.click(screen.getByRole('button', { name: 'Bevestigen' }));

    /** Ook wat er stond gaat mee: alleen dát is beoordeeld. */
    expect(onBevestig).toHaveBeenCalledWith([], ['900', '901']);
  });

  /** Waarom een sessie niet is voorgesteld, is precies de afweging die de adviseur maakt. */
  it('toont de reden waarom een sessie niet wordt voorgesteld, en laat hem aanvinken', () => {
    const onBevestig = vi.fn();
    render(
      <CyclusPanel
        keuze={{
          opties: [
            optie({ itemId: '900', huidig: true }),
            optie({
              itemId: '902',
              datum: '2027-02-01',
              aangevinkt: false,
              voorgesteld: false,
              reden: 'andere trainers',
              trainers: 'Frauke van de Wiel',
            }),
          ],
          openstaand: true,
        }}
        bezig={false}
        fout={null}
        onBevestig={onBevestig}
      />
    );

    expect(screen.getByText(/andere trainers/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/1 februari 2027/));
    fireEvent.click(screen.getByRole('button', { name: 'Bevestigen' }));

    expect(onBevestig).toHaveBeenCalledWith(['900', '902'], ['900', '902']);
  });

  it('meldt een mislukte bevestiging en blokkeert de knop zolang hij loopt', () => {
    render(
      <CyclusPanel
        keuze={{ opties: OPTIES, openstaand: false }}
        bezig
        fout="Deze sessies horen niet bij deze opdracht: 123."
        onBevestig={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Bezig…' }).getAttribute('disabled')).not.toBeNull();
    expect(screen.getByText(/horen niet bij deze opdracht/)).toBeTruthy();
  });
});
