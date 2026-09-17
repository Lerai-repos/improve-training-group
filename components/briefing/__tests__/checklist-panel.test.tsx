import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_CHECKLIST } from '@lib/briefing/blocks';

import { ChecklistPanel } from '../checklist-panel';

import type { TabPerson } from '@lib/briefing/tab';

afterEach(cleanup);

const PERSONEN: readonly TabPerson[] = [
  {
    itemId: '1',
    naam: 'Kenneth Plat',
    inActeursGroep: false,
    isCoTrainer: false,
    aangewezenAlsActeur: false,
  },
  {
    itemId: '2',
    naam: 'Jeanet Mosselman',
    inActeursGroep: true,
    isCoTrainer: false,
    aangewezenAlsActeur: false,
  },
];

const toon = (acteurBeantwoord: boolean, trainingActor: boolean) =>
  render(
    <ChecklistPanel
      checklist={{ ...EMPTY_CHECKLIST, trainingActor }}
      acteurBeantwoord={acteurBeantwoord}
      personen={PERSONEN}
      actorItemIds={[]}
      soloTrainer={false}
      groepskeuzeNvt={true}
      onChecklist={vi.fn()}
      onActors={vi.fn()}
      onAnswerActor={vi.fn()}
    />
  );

/**
 * De acteurvraag heeft geen voorgezet antwoord. Monday's voorstel als gekozen knop las als
 * "al beantwoord", terwijl juist de adviseur moet beslissen.
 */
describe('ChecklistPanel — de acteurvraag', () => {
  it('zet niets aan zolang er niet gekozen is, ook als Monday een acteur verwacht', () => {
    toon(false, true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Ja' }).checked).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Nee' }).checked).toBe(false);
    expect(screen.queryByText(/Wie is de acteur/)).toBeNull();
  });

  it('toont de keuze en de acteurkiezer zodra ja is gekozen', () => {
    toon(true, true);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Ja' }).checked).toBe(true);
    expect(screen.getByText(/Wie is de acteur/)).toBeTruthy();
  });
});

describe('ChecklistPanel — wat er niet meer staat', () => {
  /** Die drie komen van het agendabord; twee plekken voor één antwoord lopen uiteen. */
  it('vraagt niet meer naar cyclus, huiswerk of voorbereidende opdracht', () => {
    toon(true, false);
    expect(screen.queryByText('Trainingscyclus')).toBeNull();
    expect(screen.queryByText('Huiswerkopdracht')).toBeNull();
    expect(screen.queryByText('Voorbereidende opdracht')).toBeNull();
  });

  it('zegt dat er niets te kiezen is bij één trainer', () => {
    render(
      <ChecklistPanel
        checklist={EMPTY_CHECKLIST}
        acteurBeantwoord={true}
        personen={PERSONEN.slice(0, 1)}
        actorItemIds={[]}
        soloTrainer={true}
        groepskeuzeNvt={true}
        onChecklist={vi.fn()}
        onActors={vi.fn()}
        onAnswerActor={vi.fn()}
      />
    );
    expect(screen.getByText('Voor deze training zijn er geen keuzes.')).toBeTruthy();
  });
});
