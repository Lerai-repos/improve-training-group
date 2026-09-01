import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TrainerOverview } from '../trainer-overview';

import type { OverviewTrainerRow } from '@lib/evaluations';
import type { TrainerOverviewState } from '../use-trainer-overview';

afterEach(cleanup);

const trainer = (over: Partial<OverviewTrainerRow> = {}): OverviewTrainerRow => ({
  trainerExternalId: 't1',
  overallAvg: 8.4,
  evaluationCount: 12,
  themeCount: 2,
  trainingCount: 7,
  themes: [
    {
      themaExternalId: 'th1',
      weightedAvg: 8.6,
      evaluationCount: 8,
      timesTaught: 5,
      qualification: 'Groen',
    },
    {
      themaExternalId: 'th2',
      weightedAvg: 7.9,
      evaluationCount: 4,
      timesTaught: 2,
      qualification: 'Oranje',
    },
  ],
  ...over,
});

const state = (over: Partial<TrainerOverviewState> = {}): TrainerOverviewState => ({
  status: 'ready',
  payload: { writtenAt: '2026-08-31T02:45:00.000Z', stale: false, trainers: [trainer()] },
  error: null,
  names: new Map([['t1', 'Anna Bakker']]),
  themeNames: new Map([
    ['th1', 'Feedback geven'],
    ['th2', 'Timemanagement'],
  ]),
  rosterIds: [],
  theme: 'light',
  themeUnavailable: false,
  nameWarning: null,
  reload: () => {},
  ...over,
});

describe('TrainerOverview', () => {
  it('shows one row per trainer with the themes folded away', () => {
    render(<TrainerOverview state={state()} />);

    expect(screen.getByText('Anna Bakker')).toBeDefined();
    expect(screen.queryByText('Feedback geven')).toBeNull();
  });

  it('unfolds the theme rows when the trainer is clicked', () => {
    render(<TrainerOverview state={state()} />);

    fireEvent.click(screen.getByText('Anna Bakker'));

    expect(screen.getByText('Feedback geven')).toBeDefined();
    expect(screen.getByText('Timemanagement')).toBeDefined();
  });

  it('folds it away again on a second click', () => {
    render(<TrainerOverview state={state()} />);

    fireEvent.click(screen.getByText('Anna Bakker'));
    fireEvent.click(screen.getByText('Anna Bakker'));

    expect(screen.queryByText('Feedback geven')).toBeNull();
  });

  /**
   * Two trainers open at once is the whole reason the themes unfold in place rather than
   * opening a page: an evaluation round is a comparison.
   */
  it('keeps more than one trainer unfolded at a time', () => {
    render(
      <TrainerOverview
        state={state({
          payload: {
            writtenAt: '2026-08-31T02:45:00.000Z',
            stale: false,
            trainers: [trainer(), trainer({ trainerExternalId: 't2' })],
          },
          names: new Map([
            ['t1', 'Anna Bakker'],
            ['t2', 'Bert de Vries'],
          ]),
        })}
      />
    );

    fireEvent.click(screen.getByText('Anna Bakker'));
    fireEvent.click(screen.getByText('Bert de Vries'));

    expect(screen.getAllByTestId('theme-row')).toHaveLength(4);
  });

  /**
   * The filter is ON by default. Most of the roster has never been evaluated, so without
   * it the first screen is mostly empty rows.
   */
  it('hides never-evaluated trainers until the filter is switched off', () => {
    render(
      <TrainerOverview
        state={state({
          payload: {
            writtenAt: '2026-08-31T02:45:00.000Z',
            stale: false,
            trainers: [
              trainer(),
              trainer({ trainerExternalId: 't2', evaluationCount: 0, overallAvg: null }),
            ],
          },
          names: new Map([
            ['t1', 'Anna Bakker'],
            ['t2', 'Bert de Vries'],
          ]),
        })}
      />
    );

    expect(screen.queryByText('Bert de Vries')).toBeNull();

    fireEvent.click(screen.getByLabelText('Alleen trainers met evaluaties'));

    expect(screen.getByText('Bert de Vries')).toBeDefined();
  });

  it('shows a trainer with no grades as such, never as a zero', () => {
    render(
      <TrainerOverview
        state={state({
          payload: {
            writtenAt: '2026-08-31T02:45:00.000Z',
            stale: false,
            trainers: [trainer({ overallAvg: null, evaluationCount: 0, themes: [] })],
          },
        })}
      />
    );

    fireEvent.click(screen.getByLabelText('Alleen trainers met evaluaties'));

    const row = screen.getByTestId('trainer-row');
    expect(within(row).getByText('geen cijfers')).toBeDefined();
  });

  it('leaves the training count empty rather than guessing a zero', () => {
    render(<TrainerOverview state={state({ payload: {
      writtenAt: '2026-08-31T02:45:00.000Z',
      stale: false,
      trainers: [trainer({ trainingCount: null })],
    } })} />);

    const row = screen.getByTestId('trainer-row');
    expect(within(row).getByText('—')).toBeDefined();
  });

  it('says so when the numbers are behind', () => {
    render(
      <TrainerOverview
        state={state({
          payload: {
            writtenAt: '2026-08-20T02:45:00.000Z',
            stale: true,
            trainers: [trainer()],
          },
        })}
      />
    );

    expect(screen.getByRole('status').textContent).toContain('2026-08-20');
  });

  it('reports the state where the nightly job has never run', () => {
    render(
      <TrainerOverview
        state={state({ payload: { writtenAt: null, stale: false, trainers: [] } })}
      />
    );

    expect(screen.getByText(/nog niet gedraaid/)).toBeDefined();
  });

  it('shows the error rather than an empty table', () => {
    render(<TrainerOverview state={state({ status: 'error', error: 'kapot', payload: null })} />);

    expect(screen.getByText('kapot')).toBeDefined();
  });
});

/**
 * A trainer the nightly record says nothing about — only rood/grijs qualifications and no
 * completed themed history. They exist on the board, so switching the filter off has to
 * reveal them; leaving them out is what would make that checkbox a lie.
 */
describe('roster trainers without statistics', () => {
  const withRoster = () =>
    state({
      payload: { writtenAt: '2026-08-31T02:45:00.000Z', stale: false, trainers: [trainer()] },
      names: new Map([
        ['t1', 'Anna Bakker'],
        ['t2', 'Bert de Vries'],
      ]),
      rosterIds: ['t1', 't2'],
    });

  it('are hidden while the filter is on', () => {
    render(<TrainerOverview state={withRoster()} />);

    expect(screen.queryByText('Bert de Vries')).toBeNull();
  });

  it('appear once it is switched off', () => {
    render(<TrainerOverview state={withRoster()} />);

    fireEvent.click(screen.getByLabelText('Alleen trainers met evaluaties'));

    expect(screen.getByText('Bert de Vries')).toBeDefined();
  });

  it('show empty figures rather than zeroes', () => {
    render(<TrainerOverview state={withRoster()} />);

    fireEvent.click(screen.getByLabelText('Alleen trainers met evaluaties'));

    const rows = screen.getAllByTestId('trainer-row');
    const added = rows[rows.length - 1];
    expect(added === undefined ? '' : within(added).getByText('geen cijfers')).toBeDefined();
  });
});

/**
 * The unfold has to be reachable without a mouse. A clickable `<tr>` takes no focus and
 * answers no Enter or Space, so this pins the control as a real button — which is also
 * what gives the browser the keyboard behaviour for free.
 */
describe('keyboard access', () => {
  it('exposes the unfold as a button naming the trainer', () => {
    render(<TrainerOverview state={state()} />);

    const toggle = screen.getByRole('button', { name: /Anna Bakker/ });

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('reports the expanded state on that button', () => {
    render(<TrainerOverview state={state()} />);

    const toggle = screen.getByRole('button', { name: /Anna Bakker/ });
    fireEvent.click(toggle);

    expect(screen.getByRole('button', { name: /Anna Bakker/ }).getAttribute('aria-expanded')).toBe(
      'true'
    );
  });
});

/**
 * The page renders inside Monday's iframe, over Monday's canvas. Getting this wrong is
 * not cosmetic: light tokens in a dark workspace means dark text on a dark background.
 */
describe("Monday's theme", () => {
  const surface = (container: HTMLElement) => container.firstElementChild;

  it('paints nothing at all until Monday has said which theme it is', () => {
    const { container } = render(
      <TrainerOverview state={state({ theme: null, themeUnavailable: false })} />
    );

    expect(screen.queryByText('Anna Bakker')).toBeNull();
    expect(surface(container)?.className).toContain('bg-transparent');
  });

  it('applies the dark class in a dark workspace', () => {
    const { container } = render(<TrainerOverview state={state({ theme: 'dark' })} />);

    expect(surface(container)?.className).toContain('dark');
    expect(surface(container)?.className).toContain('monday-surface');
  });

  it('does not apply it in a light workspace', () => {
    const { container } = render(<TrainerOverview state={state({ theme: 'light' })} />);

    expect(surface(container)?.className).not.toContain('dark');
  });

  /**
   * A failed context read is not "not yet" — it never resolves. Waiting forever would
   * leave a permanently blank tab, so the table renders on the opaque light surface,
   * which is legible against either Monday canvas.
   */
  it('renders on an opaque surface when the context will never arrive', () => {
    const { container } = render(
      <TrainerOverview state={state({ theme: null, themeUnavailable: true })} />
    );

    expect(screen.getByText('Anna Bakker')).toBeDefined();
    expect(surface(container)?.className).toContain('bg-background');
    expect(surface(container)?.className).not.toContain('bg-transparent');
  });

  it('keeps the theme on the loading and error states too', () => {
    const loading = render(<TrainerOverview state={state({ status: 'loading', theme: 'dark' })} />);
    expect(surface(loading.container)?.className).toContain('dark');
    cleanup();

    const failed = render(
      <TrainerOverview state={state({ status: 'error', error: 'kapot', theme: 'dark' })} />
    );
    expect(surface(failed.container)?.className).toContain('dark');
  });
});
