import { describe, expect, it } from 'vitest';

import { MailSendError } from '../graph-sender';
import { isTransient, MAIL_ATTEMPTS, sendWithRetry } from '../retry';

import type { MailSender, OutgoingMail } from '../types';

const mail: OutgoingMail = { to: ['a@b.nl'], subject: 'x', body: 'y' };

/** Faalt de eerste `keer` pogingen en slaagt daarna. */
function flakySender(keer: number, error: unknown): { sender: MailSender; pogingen: () => number } {
  let n = 0;
  return {
    sender: {
      send: async () => {
        n += 1;
        if (n <= keer) {
          throw error;
        }
      },
    },
    pogingen: () => n,
  };
}

const socketWeg = new Error('fetch failed', {
  cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
});

const geenWachten = async (): Promise<void> => undefined;

describe('isTransient', () => {
  it('herkent een weggevallen socket', () => {
    expect(isTransient(socketWeg)).toBe(true);
  });

  it('herkent throttling en serverfouten van Graph', () => {
    expect(isTransient(new MailSendError(429, 'slow down', 'verzenden'))).toBe(true);
    expect(isTransient(new MailSendError(503, 'onbeschikbaar', 'verzenden'))).toBe(true);
  });

  /** Een 403 betekent dat de scope dit postvak niet toestaat; dat verandert niet in 3 seconden. */
  it('herkent een weigering NIET als storing', () => {
    expect(isTransient(new MailSendError(403, 'geen recht', 'verzenden'))).toBe(false);
    expect(isTransient(new MailSendError(400, 'kapot bericht', 'verzenden'))).toBe(false);
  });

  /**
   * De val die dit bijna stil miste: `MailSendError` komt ALLEEN van het uploaden van een
   * bijlagebrok. Elke andere stap — sendMail, concept, uploadsessie, versturen — loopt door de
   * Graph-client en werpt diens eigen fout, met dezelfde status maar een andere klasse. Werd
   * daar niet naar gekeken, dan gold een 503 op het meest gebruikte pad als blijvend.
   */
  it('herkent ook de fout van de Graph-client zelf', () => {
    const graph503 = Object.assign(new Error('Graph 503 op /users/x/sendMail: onbeschikbaar'), {
      name: 'GraphError',
      status: 503,
    });
    expect(isTransient(graph503)).toBe(true);
  });

  it('herkent een weigering van de Graph-client NIET als storing', () => {
    const graph403 = Object.assign(new Error('Graph 403 op /users/x/sendMail: geen recht'), {
      name: 'GraphError',
      status: 403,
    });
    expect(isTransient(graph403)).toBe(false);
  });

  it('probeert niet opnieuw na onze eigen looptijdgrens', () => {
    // Die grens is er nog steeds bij de tweede poging, en dan met minder tijd over.
    const afgebroken = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    expect(isTransient(afgebroken)).toBe(false);
  });
});

describe('sendWithRetry', () => {
  it('slaagt zonder herhaling als het meteen goed gaat', async () => {
    const { sender, pogingen } = flakySender(0, socketWeg);
    await sendWithRetry(sender, mail, { sleep: geenWachten });
    expect(pogingen()).toBe(1);
  });

  it('probeert opnieuw en slaagt alsnog', async () => {
    const { sender, pogingen } = flakySender(1, socketWeg);
    await sendWithRetry(sender, mail, { sleep: geenWachten });
    expect(pogingen()).toBe(2);
  });

  it('geeft het op na een begrensd aantal pogingen', async () => {
    const { sender, pogingen } = flakySender(99, socketWeg);
    await expect(sendWithRetry(sender, mail, { sleep: geenWachten })).rejects.toThrow();
    expect(pogingen()).toBe(MAIL_ATTEMPTS);
  });

  it('probeert een weigering GEEN tweede keer', async () => {
    const { sender, pogingen } = flakySender(99, new MailSendError(403, 'nee', 'verzenden'));
    await expect(sendWithRetry(sender, mail, { sleep: geenWachten })).rejects.toBeInstanceOf(
      MailSendError
    );
    expect(pogingen()).toBe(1);
  });

  it('meldt elke mislukte poging, zodat een wankel netwerk zichtbaar blijft', async () => {
    const gemeld: string[] = [];
    const { sender } = flakySender(1, socketWeg);
    await sendWithRetry(sender, mail, {
      sleep: geenWachten,
      onRetry: (poging, fout) => gemeld.push(`${poging}:${fout}`),
    });
    expect(gemeld).toHaveLength(1);
    expect(gemeld[0]).toContain('ECONNRESET');
  });

  it('wacht langer bij elke volgende poging', async () => {
    const gewacht: number[] = [];
    const { sender } = flakySender(2, socketWeg);
    await sendWithRetry(sender, mail, {
      sleep: async (ms) => {
        gewacht.push(ms);
      },
    });
    expect(gewacht).toHaveLength(2);
    expect(gewacht[1]).toBeGreaterThan(gewacht[0]);
  });
});
