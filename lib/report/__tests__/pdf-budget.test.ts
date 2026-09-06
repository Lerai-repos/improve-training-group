import { describe, expect, it } from 'vitest';

import { createPdfRenderer, MAX_RENDER_MS, renderBudget } from '../pdf';

const NU = 1_757_000_000_000;
const nu = (): number => NU;

/**
 * `runWithDeadline` breekt uit zichzelf niets af — het bewaart alleen een tijdstip. Chromium
 * keek daar tot nu toe helemaal niet naar, en één vastgelopen render kon daardoor over Vercels
 * 300 seconden heen lopen. Dan beëindigt het platform de functie, en is er geen `catch` meer:
 * geen melding, geen teruggegeven claim, en de trainingen die nog in de rij stonden blijven
 * liggen.
 */
describe('renderBudget', () => {
  it('gebruikt de resterende tijd van de looptijdgrens', () => {
    expect(renderBudget(() => NU + 30_000, nu)).toBe(30_000);
  });

  it('rekent met de RESTERENDE tijd, niet met het tijdstip zelf', () => {
    expect(renderBudget(() => NU + 30_000, nu)).not.toBe(NU + 30_000);
  });

  it('kapt af op de eigen bovengrens als de route nog zeeën van tijd heeft', () => {
    expect(renderBudget(() => NU + 10 * MAX_RENDER_MS, nu)).toBe(MAX_RENDER_MS);
  });

  it('geeft nul als de grens al voorbij is, en nooit een negatief getal', () => {
    expect(renderBudget(() => NU - 5_000, nu)).toBe(0);
  });

  it('houdt ook zonder looptijdgrens een bovengrens aan', () => {
    // Een script heeft geen route-deadline; een vastgelopen Chromium is daar net zo min gewenst.
    expect(renderBudget(undefined, nu)).toBe(MAX_RENDER_MS);
    expect(renderBudget(() => null, nu)).toBe(MAX_RENDER_MS);
  });
});

/**
 * Puppeteer leest `timeout: 0` als "geen tijdslimiet". Een leeg budget zou dus élke grens
 * uitzetten in plaats van aanzetten — precies het tegenovergestelde van de bedoeling. Dus
 * stopt de renderer ervóór, zonder een browser te starten.
 */
describe('een verstreken looptijdgrens', () => {
  it('weigert te renderen in plaats van zonder grens te beginnen', async () => {
    const renderer = createPdfRenderer(() => Date.now() - 1_000);
    await expect(renderer.render('<p>hoi</p>')).rejects.toThrow(/Geen tijd meer/);
  });

  it('start daarvoor geen Chromium', async () => {
    // Zou hij dat wél doen, dan duurde deze test seconden in plaats van milliseconden.
    const begin = Date.now();
    const renderer = createPdfRenderer(() => Date.now() - 1_000);
    await expect(renderer.render('<p>hoi</p>')).rejects.toThrow();
    expect(Date.now() - begin).toBeLessThan(1_000);
  });
});
