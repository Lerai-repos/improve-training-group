import { describe, expect, it } from 'vitest';

import { deadlineSignal, remainingMs } from '../deadline';

const NU = 1_757_000_000_000;

describe('remainingMs', () => {
  /**
   * De fout die dit bestand bestaansrecht geeft: de grens is een tijdstip, geen duur. Werd
   * hij als duur doorgegeven, dan stond er een tijdslimiet van tienduizenden jaren.
   */
  it('rekent een absoluut tijdstip om naar wat er nog over is', () => {
    expect(remainingMs(NU + 30_000, NU)).toBe(30_000);
  });

  it('geeft niet het tijdstip zelf terug', () => {
    expect(remainingMs(NU + 30_000, NU)).not.toBe(NU + 30_000);
  });

  it('wordt nooit negatief als de grens al voorbij is', () => {
    expect(remainingMs(NU - 5_000, NU)).toBe(0);
  });

  it('is null als er geen grens is', () => {
    expect(remainingMs(null, NU)).toBeNull();
  });
});

describe('deadlineSignal', () => {
  it('geeft geen signaal buiten elke grens', () => {
    expect(deadlineSignal(() => null)).toBeUndefined();
  });

  it('geeft een signaal binnen een grens, dat nog niet is afgegaan', () => {
    const signal = deadlineSignal(
      () => NU + 30_000,
      () => NU
    );
    expect(signal?.aborted).toBe(false);
  });

  /**
   * De grens wordt bij ELKE aanroep opnieuw uitgelezen. Eén keer bij het opbouwen van de deps
   * uitlezen was precies de bug: de route bouwt die deps vóórdat hij `runWithDeadline`
   * binnengaat, dus daar bestaat de grens nog niet.
   */
  it('leest de grens elke keer opnieuw uit', () => {
    let waarde: number | null = null;
    const lees = (): number | null => waarde;

    expect(deadlineSignal(lees, () => NU)).toBeUndefined();
    waarde = NU + 30_000;
    expect(deadlineSignal(lees, () => NU)).toBeDefined();
  });
});
