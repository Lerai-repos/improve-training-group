import { describe, expect, it } from 'vitest';

import { CHUNK_BYTES, createGraphMailSender, MailSendError } from '../graph-sender';

import type { UploadFetch } from '../graph-sender';
import type { OutgoingMail } from '../types';

interface Call {
  pad: string;
  init?: RequestInit;
}

interface Put {
  url: string;
  range: string;
  length: number;
  type: string;
}

function harness(options: { uploadStatus?: number } = {}) {
  const calls: Call[] = [];
  const puts: Put[] = [];

  const client = {
    async json(pad: string, init?: RequestInit): Promise<unknown> {
      calls.push({ pad, init });
      if (pad.endsWith('/messages')) {
        return { id: 'draft-1' };
      }
      if (pad.endsWith('/createUploadSession')) {
        return { uploadUrl: 'https://upload.voorbeeld/1' };
      }
      return null;
    },
  };

  const uploadFetch: UploadFetch = async (url, init) => {
    const headers = new Headers(init.headers);
    puts.push({
      url,
      range: headers.get('Content-Range') ?? '',
      length: Number(headers.get('Content-Length') ?? '0'),
      type: headers.get('Content-Type') ?? '',
    });
    return {
      status: options.uploadStatus ?? 201,
      text: async () => '',
    };
  };

  const sender = createGraphMailSender({
    client,
    sender: 'automatisering@voorbeeld.nl',
    uploadFetch,
  });
  return { sender, calls, puts };
}

const zonderBijlage: OutgoingMail = {
  to: ['aanvragen@voorbeeld.nl'],
  subject: 'Onderwerp',
  body: 'Tekst',
};

describe('zonder bijlage', () => {
  it('gaat in één sendMail en raakt geen uploadsessie aan', async () => {
    const { sender, calls, puts } = harness();
    await sender.send(zonderBijlage);
    expect(calls).toHaveLength(1);
    expect(calls[0].pad).toBe('/users/automatisering%40voorbeeld.nl/sendMail');
    expect(puts).toHaveLength(0);
  });

  it('bewaart in Verzonden items, zodat er een spoor is', async () => {
    const { sender, calls } = harness();
    await sender.send(zonderBijlage);
    const body: unknown = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({ saveToSentItems: true });
  });

  it('weigert een mail zonder geadresseerde', async () => {
    const { sender } = harness();
    await expect(sender.send({ ...zonderBijlage, to: [] })).rejects.toThrow(/geadresseerde/);
  });
});

const metBijlage = (bytes: Uint8Array): OutgoingMail => ({
  ...zonderBijlage,
  attachment: { filename: 'rapport.pdf', contentType: 'application/pdf', bytes },
});

/**
 * Graph schrijft de grens zelf voor: onder 3 MB hoort de bijlage in het bericht, van 3 tot
 * 150 MB door een uploadsessie. Een echt evaluatierapport meet 2,6 MB en valt dus in de
 * eerste band — precies het gewone geval.
 */
const KLEIN = 2_600_000;
const GROOT = 3 * 1024 * 1024;

describe('een bijlage onder de 3 MB', () => {
  it('gaat mee in het bericht, in één aanroep', async () => {
    const { sender, calls, puts } = harness();
    await sender.send(metBijlage(new Uint8Array(KLEIN)));

    expect(calls).toHaveLength(1);
    expect(calls[0].pad).toBe('/users/automatisering%40voorbeeld.nl/sendMail');
    expect(puts).toHaveLength(0);
  });

  it('stuurt het bestand als base64 met zijn naam en type mee', async () => {
    const { sender, calls } = harness();
    await sender.send(metBijlage(new Uint8Array([1, 2, 3, 4])));

    const body: unknown = JSON.parse(String(calls[0].init?.body));
    expect(body).toMatchObject({
      message: {
        attachments: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'rapport.pdf',
            contentType: 'application/pdf',
            contentBytes: Buffer.from([1, 2, 3, 4]).toString('base64'),
          },
        ],
      },
    });
  });

  it('gebruikt de uploadsessie NIET, want die begint pas bij 3 MB', async () => {
    const { sender, calls } = harness();
    await sender.send(metBijlage(new Uint8Array(GROOT - 1)));
    expect(calls.map((c) => c.pad)).not.toContain('/users/automatisering%40voorbeeld.nl/messages');
  });
});

describe('een bijlage van 3 MB of meer', () => {
  it('loopt via concept, uploadsessie en send — nooit via sendMail', async () => {
    const { sender, calls } = harness();
    await sender.send(metBijlage(new Uint8Array(GROOT)));
    const paden = calls.map((c) => c.pad);
    expect(paden).toEqual([
      '/users/automatisering%40voorbeeld.nl/messages',
      '/users/automatisering%40voorbeeld.nl/messages/draft-1/attachments/createUploadSession',
      '/users/automatisering%40voorbeeld.nl/messages/draft-1/send',
    ]);
    expect(paden).not.toContain('/users/automatisering%40voorbeeld.nl/sendMail');
  });

  it('meldt de echte grootte aan de uploadsessie', async () => {
    const { sender, calls } = harness();
    await sender.send(metBijlage(new Uint8Array(GROOT)));
    const body: unknown = JSON.parse(String(calls[1].init?.body));
    expect(body).toMatchObject({ AttachmentItem: { size: GROOT, name: 'rapport.pdf' } });
  });

  it('zet op elke brok het verplichte content-type', async () => {
    // Node leidt geen MIME-type af uit een ArrayBuffer; zonder deze header wijst Graph af.
    const { sender, puts } = harness();
    await sender.send(metBijlage(new Uint8Array(CHUNK_BYTES + 10)));
    expect(puts).toHaveLength(2);
    expect(puts.every((p) => p.type === 'application/octet-stream')).toBe(true);
  });

  it('knipt een groot bestand in aaneensluitende brokken', async () => {
    const { sender, puts } = harness();
    const grootte = CHUNK_BYTES * 2 + 500;
    await sender.send(metBijlage(new Uint8Array(grootte)));

    expect(puts).toHaveLength(3);
    expect(puts[0].range).toBe(`bytes 0-${CHUNK_BYTES - 1}/${grootte}`);
    expect(puts[1].range).toBe(`bytes ${CHUNK_BYTES}-${CHUNK_BYTES * 2 - 1}/${grootte}`);
    expect(puts[2].range).toBe(`bytes ${CHUNK_BYTES * 2}-${grootte - 1}/${grootte}`);
    // De laatste brok is de rest, niet een volle brok.
    expect(puts[2].length).toBe(500);
    expect(puts.every((p) => p.url === 'https://upload.voorbeeld/1')).toBe(true);
  });

  it('telt de bytes van alle brokken op tot het hele bestand', async () => {
    const { sender, puts } = harness();
    const grootte = CHUNK_BYTES + 1;
    await sender.send(metBijlage(new Uint8Array(grootte)));
    expect(puts.reduce((som, p) => som + p.length, 0)).toBe(grootte);
  });

  it('stuurt een bestand dat precies één brok is in één keer', async () => {
    const { sender, puts } = harness();
    await sender.send(metBijlage(new Uint8Array(CHUNK_BYTES)));
    expect(puts).toHaveLength(1);
    expect(puts[0].range).toBe(`bytes 0-${CHUNK_BYTES - 1}/${CHUNK_BYTES}`);
  });

  it('weigert een lege bijlage in plaats van een uploadsessie van nul bytes', async () => {
    const { sender } = harness();
    await expect(sender.send(metBijlage(new Uint8Array(0)))).rejects.toThrow(/leeg/);
  });

  it('stopt als Graph geen uploadUrl teruggeeft, in plaats van naar "undefined" te PUTten', async () => {
    const calls: Call[] = [];
    const sender = createGraphMailSender({
      client: {
        async json(pad: string, init?: RequestInit): Promise<unknown> {
          calls.push({ pad, init });
          return pad.endsWith('/messages') ? { id: 'draft-1' } : {};
        },
      },
      sender: 'automatisering@voorbeeld.nl',
      uploadFetch: async () => {
        throw new Error('had niet aangeroepen mogen worden');
      },
    });
    await expect(sender.send(metBijlage(new Uint8Array(GROOT)))).rejects.toThrow(/uploadUrl/);
  });

  it('verstuurt niet als een brok mislukt', async () => {
    const { sender, calls } = harness({ uploadStatus: 507 });
    await expect(sender.send(metBijlage(new Uint8Array(GROOT)))).rejects.toBeInstanceOf(
      MailSendError
    );
    expect(calls.map((c) => c.pad)).not.toContain(
      '/users/automatisering%40voorbeeld.nl/messages/draft-1/send'
    );
  });
});
