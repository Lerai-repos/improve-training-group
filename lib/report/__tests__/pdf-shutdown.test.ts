import { describe, expect, it } from 'vitest';

import { sluitAf } from '../pdf';

import type { Sluitbaar } from '../pdf';

/** Een browser die zich gedraagt zoals gevraagd, en bijhoudt wat er met hem gebeurde. */
function browser(over: { closeHangs?: boolean; blijftVerbonden?: boolean } = {}) {
  const log: string[] = [];
  let verbonden = true;
  const dubbel: Sluitbaar = {
    close: async () => {
      log.push('close');
      if (over.closeHangs === true) {
        await new Promise<void>(() => undefined);
      }
      if (over.blijftVerbonden !== true) {
        verbonden = false;
      }
    },
    get connected() {
      return verbonden;
    },
    process: () => ({
      kill: (signal: 'SIGKILL') => {
        log.push(`kill:${signal}`);
        verbonden = false;
        return true;
      },
    }),
  };
  return { dubbel, log };
}

describe('sluitAf', () => {
  it('sluit netjes en doodt niets als dat lukt', async () => {
    const { dubbel, log } = browser();
    await sluitAf(dubbel, 50);
    expect(log).toEqual(['close']);
  });

  /**
   * `close()` kan zelf blijven hangen op een browser die niet meer antwoordt. Zonder eigen
   * grens is de opruiming dan precies zo erg als het probleem waarvoor ze bestaat.
   */
  it('wacht niet eeuwig op een close die hangt', async () => {
    const { dubbel, log } = browser({ closeHangs: true, blijftVerbonden: true });
    const begin = Date.now();
    await sluitAf(dubbel, 30);
    expect(Date.now() - begin).toBeLessThan(1_000);
    expect(log).toEqual(['close', 'kill:SIGKILL']);
  });

  it('doodt het proces als de browser verbonden blijft', async () => {
    const { dubbel, log } = browser({ blijftVerbonden: true });
    await sluitAf(dubbel, 50);
    expect(log).toContain('kill:SIGKILL');
  });

  it('laat een fout bij het sluiten de opruiming niet omgooien', async () => {
    const stuk: Sluitbaar = {
      close: async () => {
        throw new Error('kapot');
      },
      connected: false,
      process: () => null,
    };
    await expect(sluitAf(stuk, 50)).resolves.toBeUndefined();
  });

  it('overleeft een browser zonder proces', async () => {
    const zonder: Sluitbaar = {
      close: async () => undefined,
      connected: true,
      process: () => null,
    };
    await expect(sluitAf(zonder, 50)).resolves.toBeUndefined();
  });
});
