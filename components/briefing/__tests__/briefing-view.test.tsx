import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_SAVED } from '@lib/briefing/answers';
import { buildTabView } from '@lib/briefing/tab';

import { BriefingView } from '../briefing-view';

import type { GenerateState } from '../generate-panel';
import type { UseBriefingView } from '../use-briefing-view';
import type { BriefingTraining } from '@lib/briefing/types';

afterEach(cleanup);

/**
 * De bedrading van de tab, en dan vooral wat elkaar in de weg mag zitten.
 *
 * Bevestigen en Genereren gaan over hetzelfde: welke sessies in dit document horen. Wie ze
 * tegelijk kan starten, kan een briefing laten schrijven voor een cyclus die op dat moment
 * verandert — dus zolang de één loopt, staat de ander stil.
 */

const sessie = (itemId: string, datum: string) => ({
  itemId,
  boardId: '5087396949',
  gearchiveerd: false,
  datum,
  tijden: '09:00 - 13:00',
  locatie: 'Almere',
  groepsgrootte: '12',
  zonderThema: false,
});

const optie = (itemId: string, huidig: boolean) => ({
  itemId,
  datum: huidig ? '2026-09-22' : '2027-01-04',
  klanttitel: 'Navigating difficult conversations',
  trainers: 'Isabelle Zwetsloot',
  huidig,
  aangevinkt: true,
  voorgesteld: true,
  reden: null,
});

const TRAINING: BriefingTraining = {
  itemId: '900',
  naam: 'International School Almere',
  label: 'IT',
  brie: 'Aanmaken',
  opdrachtgever: 'International School Almere',
  themas: ['Moeilijke gesprekken'],
  trainingscodeMc: 'IT-30',
  themaInhoud: 'Plenaire opening.',
  klanttitel: 'Navigating difficult conversations',
  duur: '4',
  datum: '2026-09-22',
  tijden: '09:00 - 13:00',
  groepsgrootte: '50',
  locatie: 'Almere',
  voertaal: 'NL',
  klantcontactmoment: 'Teams',
  evaluatie: 'Nee',
  ieCode: '',
  accountmanager: { naam: 'Dirkje', mobiel: '06' },
  contactpersoon: { naam: 'Suzanne', telefoon: '06' },
  trainers: [
    { itemId: 't1', naam: 'Isabelle Zwetsloot', telefoon: '', isActeur: false, isCoTrainer: false },
  ],
  acteuraantal: null,
  opportunityItemId: 'opp1',
  achtergrond: 'Iets over de klant.',
  opdrachten: { trainingCycle: true, homework: false, preparatoryAssignment: false },
  cyclus: { sessies: [sessie('900', '2026-09-22'), sessie('901', '2027-01-04')], anker: '900' },
  cyclusKeuze: { opties: [optie('900', true), optie('901', false)], openstaand: false },
  missing: [],
};

function stel(over: {
  cyclus?: UseBriefingView['cyclus'];
  generate?: GenerateState;
}): { view: UseBriefingView; generate: Parameters<typeof BriefingView>[0]['generate'] } {
  const view: UseBriefingView = {
    itemId: '900',
    theme: 'light',
    status: {
      kind: 'loaded',
      payload: { training: TRAINING, saved: null, token: 't', unreadable: false },
      view: buildTabView(TRAINING, { ...EMPTY_SAVED, actorAnswered: true }),
    },
    save: { kind: 'rust' },
    answers: EMPTY_SAVED,
    locked: false,
    setChecklist: vi.fn(),
    setActorItemIds: vi.fn(),
    answerActor: vi.fn(),
    unlock: vi.fn(),
    refresh: vi.fn(),
    flush: () => Promise.resolve(true),
    bevestigCyclus: vi.fn(),
    cyclus: over.cyclus ?? { kind: 'rust' },
  };
  return {
    view,
    generate: {
      state: over.generate ?? { kind: 'idle' },
      generate: vi.fn(),
      confirm: vi.fn(),
      cancel: vi.fn(),
    },
  };
}

const knop = (naam: RegExp) => screen.getByRole('button', { name: naam });

describe('BriefingView', () => {
  it('laat beide knoppen werken als er niets loopt', () => {
    const { view, generate } = stel({});
    render(<BriefingView view={view} generate={generate} />);

    expect(knop(/Bevestigen/).getAttribute('disabled')).toBeNull();
    expect(knop(/Plan controleren/).getAttribute('disabled')).toBeNull();
  });

  it('zet Genereren stil terwijl de cyclus wordt bevestigd', () => {
    const { view, generate } = stel({ cyclus: { kind: 'bezig' } });
    render(<BriefingView view={view} generate={generate} />);

    expect(knop(/Plan controleren/).getAttribute('disabled')).not.toBeNull();
  });

  /** Een vinkje tijdens het bevestigen zou naar het oude anker schrijven. */
  it('zet de keuzes op slot terwijl de cyclus wordt bevestigd', () => {
    const { view, generate } = stel({ cyclus: { kind: 'bezig' } });
    render(<BriefingView view={view} generate={generate} />);

    const groep = screen.getAllByRole('group').find((g) => g.getAttribute('disabled') !== null);
    expect(groep).toBeTruthy();
  });

  it('zet Bevestigen stil terwijl er gegenereerd wordt', () => {
    const { view, generate } = stel({ generate: { kind: 'bezig', schrijft: false } });
    render(<BriefingView view={view} generate={generate} />);

    expect(knop(/Bezig…/).getAttribute('disabled')).not.toBeNull();
  });
});
