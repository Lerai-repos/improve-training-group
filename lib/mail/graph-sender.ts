import type { MailAttachment, MailSender, OutgoingMail } from './types';

/**
 * Verzenden via Microsoft Graph, app-only, als één vast postvak.
 *
 * Dezelfde app-registratie die de briefings naar SharePoint schrijft. Het recht om te mailen
 * komt **niet** uit een Entra-permissie maar uit een Exchange-roltoewijzing die op één
 * postvak is begrensd; zie het geheugen `itg-exchange-mail-rbac`. Zou hier ooit een
 * tenantbrede `Mail.Send` bij komen, dan wint die van de begrenzing, want de twee
 * rechtenbronnen zijn een unie.
 *
 * ## Twee paden voor een bijlage, en de grens ligt niet bij ons
 *
 * Graph schrijft ze allebei voor en zegt erbij wanneer: onder 3 MB hoort een bijlage gewoon
 * in het bericht, van 3 tot 150 MB hoort hij door een uploadsessie. Die ondergrens is geen
 * aanbeveling maar de rand van wat de sessie aanneemt.
 *
 * Een eerdere versie hiervan stuurde álles door de uploadsessie, met het argument dat één
 * pad dat altijd werkt beter is dan twee waarvan het tweede zelden beproefd wordt. Dat
 * argument klopt alleen als dat ene pad ook echt altijd werkt — en een echt evaluatierapport
 * meet 2,6 MB en valt dus in de band waar de sessie níét voor is. Het gekozen pad was
 * precies het verkeerde voor het gewone geval.
 *
 * De reden dat de grens bij 3 MB ligt is base64: dat maakt een bestand een derde groter, dus
 * 3 MB aan bytes is 4 MB aan verzoek, en dat is de bovengrens van één Graph-verzoek.
 */

/**
 * De Graph-client, zo smal mogelijk opgeschreven.
 *
 * `Promise<unknown>` en niet `Promise<T>`. De echte client kán die belofte alleen met een
 * cast waarmaken, en elke testdubbel zou diezelfde cast moeten overnemen — juist daar waar
 * zichtbaar hoort te zijn dat de vorm klopt. Wat Graph teruggeeft wordt hieronder gecontroleerd
 * in plaats van aangenomen.
 */
interface GraphJson {
  json(pad: string, init?: RequestInit): Promise<unknown>;
}

/**
 * De PUT naar de uploadsessie, smaller dan `fetch`.
 *
 * `fetch` zelf past hier gewoon in; een testdubbel hoeft niet de hele `fetch`-signatuur na te
 * bouwen om erin te passen, en dat scheelt precies de cast die zo'n dubbel anders nodig heeft.
 */
export type UploadFetch = (
  url: string,
  init: RequestInit
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/**
 * De brokgrootte moet een veelvoud van 320 KiB zijn; dat is een eis van de uploadsessie zelf,
 * niet van ons. Tien blokken is 3,125 MiB en blijft daarmee ruim onder de verzoeklimiet.
 */
const KIB_320 = 327_680;
export const CHUNK_BYTES = KIB_320 * 10;

const OK_UPLOAD_STATUSES: ReadonlySet<number> = new Set([200, 201, 202, 204]);

/**
 * Onder deze grens gaat de bijlage gewoon mee in het bericht.
 *
 * Op de BYTES van het bestand, niet op de base64-lengte: dat is hoe Graph de grens zelf
 * beschrijft, en 3 MB aan bytes is ruwweg 4 MB aan verzoek — de bovengrens van één aanroep.
 */
const INLINE_MAX_BYTES = 3 * 1024 * 1024;

export interface GraphMailOptions {
  readonly client: GraphJson;
  /** Het postvak waaruit verzonden wordt; moet binnen de Exchange-scope vallen. */
  readonly sender: string;
  /**
   * De brokken gaan naar een absolute, vooraf geautoriseerde URL van de uploadsessie.
   *
   * Die URL draagt zijn eigen token, dus er hoort géén Authorization-header bij en hij loopt
   * niet door de Graph-client. Injecteerbaar zodat dit getest kan worden zonder netwerk.
   */
  readonly uploadFetch?: UploadFetch;
  readonly chunkBytes?: number;
}

/**
 * Eén tekstveld uit een Graph-antwoord, of een fout die zegt wát er miste.
 *
 * Zonder deze controle zou een onverwacht antwoord pas verderop opvallen: een ontbrekende
 * `uploadUrl` levert een PUT naar de letterlijke tekst `undefined` op, en een ontbrekende
 * concept-id een pad met `undefined` erin. Allebei falen ze dan met een foutmelding die naar
 * de verkeerde plek wijst.
 */
function leesVeld(data: unknown, veld: string, stap: string): string {
  if (typeof data === 'object' && data !== null && veld in data) {
    const waarde = Reflect.get(data, veld);
    if (typeof waarde === 'string' && waarde !== '') {
      return waarde;
    }
  }
  throw new Error(`Graph gaf bij ${stap} geen bruikbare \`${veld}\` terug.`);
}

const recipients = (adressen: readonly string[]): Array<{ emailAddress: { address: string } }> =>
  adressen.map((address) => ({ emailAddress: { address } }));

const messageBody = (mail: OutgoingMail): Record<string, unknown> => ({
  subject: mail.subject,
  body: { contentType: 'Text', content: mail.body },
  toRecipients: recipients(mail.to),
});

/** De bijlage zoals Graph hem in een bericht verwacht: base64, met het type erbij. */
const fileAttachment = (bijlage: MailAttachment): Record<string, unknown> => ({
  '@odata.type': '#microsoft.graph.fileAttachment',
  name: bijlage.filename,
  contentType: bijlage.contentType,
  contentBytes: Buffer.from(bijlage.bytes).toString('base64'),
});

export class MailSendError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    stap: string
  ) {
    super(`Mail ${status} bij ${stap}: ${detail}`);
    this.name = 'MailSendError';
  }
}

export function createGraphMailSender(options: GraphMailOptions): MailSender {
  const { client, sender } = options;
  const doFetch = options.uploadFetch ?? fetch;
  const chunk = options.chunkBytes ?? CHUNK_BYTES;
  const user = `/users/${encodeURIComponent(sender)}`;

  /** Eén brok, met het bereik dat Graph verwacht: `bytes start-eind/totaal`, eind inclusief. */
  const uploadChunk = async (
    uploadUrl: string,
    bytes: Uint8Array,
    start: number,
    einde: number
  ): Promise<void> => {
    const stuk = bytes.subarray(start, einde);
    /**
     * Een eigen kopie, om dezelfde reden als in `lib/sharepoint/graph.ts`: `BodyInit` neemt
     * geen `Uint8Array` die over een `SharedArrayBuffer` zou kunnen liggen, en een verse
     * array kan ook niet meer onder de lopende upload vandaan veranderen.
     */
    const body = new Uint8Array(stuk.byteLength);
    body.set(stuk);

    const res: { status: number; text(): Promise<string> } = await doFetch(uploadUrl, {
      method: 'PUT',
      headers: {
        /**
         * `application/octet-stream` is verplicht op elke brok.
         *
         * Node leidt geen MIME-type af uit een `ArrayBuffer`, dus zonder deze regel gaat het
         * verzoek zonder type de deur uit en wijst Graph het af — bij het grootste rapport,
         * op de plek die het minst vaak gelopen wordt.
         */
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.byteLength),
        'Content-Range': `bytes ${start}-${einde - 1}/${bytes.byteLength}`,
      },
      body: body.buffer,
    });
    if (!OK_UPLOAD_STATUSES.has(res.status)) {
      const tekst = await res.text();
      throw new MailSendError(res.status, tekst.slice(0, 400), `uploaden van ${start}`);
    }
  };

  /** Het kleine pad: bericht en bijlage in één aanroep, zoals Graph het onder 3 MB wil. */
  const stuurKlein = async (mail: OutgoingMail, bijlage: MailAttachment): Promise<void> => {
    await client.json(`${user}/sendMail`, {
      method: 'POST',
      body: JSON.stringify({
        message: { ...messageBody(mail), attachments: [fileAttachment(bijlage)] },
        saveToSentItems: true,
      }),
    });
  };

  /** Het grote pad: concept, uploadsessie, versturen. Vanaf 3 MB het enige dat mag. */
  const stuurGroot = async (mail: OutgoingMail, bijlage: MailAttachment): Promise<void> => {
    const draftData = await client.json(`${user}/messages`, {
      method: 'POST',
      body: JSON.stringify(messageBody(mail)),
    });
    const draftId = leesVeld(draftData, 'id', 'het aanmaken van het concept');

    const sessieData = await client.json(
      `${user}/messages/${draftId}/attachments/createUploadSession`,
      {
        method: 'POST',
        body: JSON.stringify({
          AttachmentItem: {
            attachmentType: 'file',
            name: bijlage.filename,
            size: bijlage.bytes.byteLength,
            contentType: bijlage.contentType,
          },
        }),
      }
    );
    const uploadUrl = leesVeld(sessieData, 'uploadUrl', 'het openen van de uploadsessie');

    for (let start = 0; start < bijlage.bytes.byteLength; start += chunk) {
      const einde = Math.min(start + chunk, bijlage.bytes.byteLength);
      await uploadChunk(uploadUrl, bijlage.bytes, start, einde);
    }

    await client.json(`${user}/messages/${draftId}/send`, { method: 'POST' });
  };

  return {
    async send(mail: OutgoingMail): Promise<void> {
      if (mail.to.length === 0) {
        throw new Error('Een mail zonder geadresseerde; dat is een fout in de aanroeper.');
      }
      const bijlage = mail.attachment;
      if (bijlage !== undefined && bijlage.bytes.byteLength === 0) {
        throw new Error(`Bijlage ${bijlage.filename} is leeg; er valt niets te versturen.`);
      }
      if (bijlage === undefined) {
        await client.json(`${user}/sendMail`, {
          method: 'POST',
          body: JSON.stringify({
            message: messageBody(mail),
            /**
             * Bewaren in Verzonden items.
             *
             * Dit is de enige plek waar terug te zien is wat er precies de deur uit ging; het
             * postvak is van ITG en zij kijken erin als een accountmanager iets mist.
             */
            saveToSentItems: true,
          }),
        });
        return;
      }
      if (bijlage.bytes.byteLength < INLINE_MAX_BYTES) {
        await stuurKlein(mail, bijlage);
        return;
      }
      await stuurGroot(mail, bijlage);
    },
  };
}
