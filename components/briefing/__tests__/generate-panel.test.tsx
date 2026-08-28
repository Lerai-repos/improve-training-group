import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GeneratePanel, type GenerateState } from '../generate-panel';

import type { BriefingPlan } from '../api';

afterEach(cleanup);

/**
 * Wat de knop BELOOFT moet zijn wat hij doet.
 *
 * De eerste druk plant alleen: hij kijkt waar het document heen gaat en wat er al ligt, en
 * schrijft niets. Stond er dan "Genereren" op, dan drukte de adviseur op genereren en
 * gebeurde er zichtbaar niets — precies wat er in de eerste echte test misging.
 */

const PLAN: BriefingPlan = {
  stage: 'planned',
  folderPath: 'General/4. FV/5. Klanten/2026/Repair care',
  folderExists: true,
  conflicts: [],
  related: [],
  filenames: ['Briefing Repair Care - Vitaliteit - 22-09-2026 - Pauline.docx'],
  planToken: 'abc',
};

const toon = (state: GenerateState, kanGenereren = true) =>
  render(
    <GeneratePanel
      state={state}
      kanGenereren={kanGenereren}
      onGenerate={vi.fn()}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />
  );

describe('GeneratePanel — wat de knop belooft', () => {
  it('noemt de eerste druk een controle, niet genereren', () => {
    toon({ kind: 'idle' });

    expect(screen.getByRole('button').textContent).toBe('Plan controleren');
  });

  it('wordt pas "Ja, genereren" als het plan getoond is', () => {
    toon({ kind: 'gepland', plan: PLAN });

    expect(screen.getByRole('button', { name: /Ja, genereren/ })).toBeDefined();
  });

  it('toont bij een getoond plan waar het heen gaat', () => {
    toon({ kind: 'gepland', plan: PLAN });

    expect(screen.getByText(PLAN.folderPath)).toBeDefined();
    expect(screen.getByText(PLAN.filenames[0])).toBeDefined();
  });

  /**
   * Een nieuwe map is nieuws: de adviseur ziet dan of hij een typefout op het bord aan het
   * vereeuwigen is voordat de map er staat.
   */
  it('zegt het als de map nog aangemaakt moet worden', () => {
    toon({ kind: 'gepland', plan: { ...PLAN, folderExists: false } });

    expect(screen.getByText(/map wordt aangemaakt/)).toBeDefined();
  });

  /** Botsingen hebben hun eigen knop; die mag niet in "Ja, genereren" veranderen. */
  it('houdt de botsingsknop apart', () => {
    toon({ kind: 'bevestigen', plan: { ...PLAN, conflicts: PLAN.filenames } });

    expect(screen.getByRole('button', { name: /Toch genereren/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /Ja, genereren/ })).toBeNull();
  });

  /**
   * De knop mag tijdens het schrijven niet terugvallen op "Plan controleren".
   *
   * Plannen en schrijven waren allebei gewoon `bezig`, dus zodra de adviseur op "Ja,
   * genereren" drukte stond er weer "Plan controleren" op de knop — precies tijdens de
   * minuut waarin er wél bestanden worden weggeschreven. Dat is de omgekeerde leugen van de
   * bug die deze knoptekst moest oplossen.
   */
  it('zegt tijdens het controleren dat het controleert', () => {
    toon({ kind: 'bezig', schrijft: false });

    expect(screen.getByRole('button').textContent).toContain('Controleren');
  });

  it('zegt tijdens het schrijven dat het genereert, niet dat het controleert', () => {
    toon({ kind: 'bezig', schrijft: true });

    expect(screen.getByRole('button').textContent).toContain('Genereren');
    expect(screen.getByRole('button').textContent).not.toContain('Plan controleren');
  });

  it('is uitgeschakeld zolang er iets blokkeert', () => {
    toon({ kind: 'idle' }, false);

    expect(screen.getByRole('button')).toHaveProperty('disabled', true);
  });
});
