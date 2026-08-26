import { GraphError, type GraphClient } from './graph';

import type { FolderLister } from './resolve';

/**
 * De documentbibliotheek als iets waar je mappen in kunt lezen en bestanden in kunt zetten.
 *
 * `resolve.ts` rekent uit wáár een briefing hoort; dit is het enige stuk dat SharePoint echt
 * aanraakt. Het scheiden van die twee is wat de hele mappenlogica testbaar maakt zonder
 * netwerk of tenant.
 */

/** Wat `find` teruggeeft: een `UploadedFile` plus genoeg om te toetsen of hij van ons is. */
export interface FoundFile extends UploadedFile {
  readonly size: number;
}

export interface UploadedFile {
  readonly id: string;
  readonly name: string;
  /** De link die in Monday en op het Briefings-bord terechtkomt. */
  readonly webUrl: string;
}

export interface BriefingStore extends FolderLister {
  /** De BESTANDEN in een map. Bepaalt of er al een briefing ligt. */
  files(path: string): Promise<readonly string[]>;
  /**
   * Is dit bestand er, en zo ja: hoe heet het en waar staat het?
   *
   * Voor ná een upload waarvan het antwoord verloren ging. SharePoint kan de PUT hebben
   * vastgelegd terwijl de verbinding wegviel — dan werpt `upload` terwijl het bestand er wél
   * staat, en zou het als wees achterblijven: niet in `written`, dus niet in Monday.
   */
  find(folderPath: string, filename: string): Promise<FoundFile | null>;
  /** Maakt de map aan; bestaat hij al, dan is dat geen fout. */
  createFolder(parentPath: string, name: string): Promise<void>;
  upload(folderPath: string, filename: string, bytes: Uint8Array): Promise<UploadedFile>;
}

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Een pad naar de vorm die Graph in `/root:/…:/` verwacht.
 *
 * Per segment coderen en de schuine strepen heel laten: mapnamen bevatten spaties en punten
 * (`5. Klanten`), en die moeten gecodeerd worden zonder dat de padscheiding sneuvelt.
 */
function encodePath(pad: string): string {
  return pad
    .split('/')
    .filter((deel) => deel !== '')
    .map(encodeURIComponent)
    .join('/');
}

interface DriveChild {
  name: string;
  folder?: { childCount: number };
}

export function createSharePointStore(
  client: GraphClient,
  siteId: string,
  /**
   * Een tweede client voor het herstel ná een afgebroken upload.
   *
   * De gewone client draagt het afbreeksignaal van de route. Precies wanneer dat signaal
   * afgaat — de timeout waar dit herstel voor bestaat — zou de herstelvraag er dus zelf ook
   * meteen in blijven. Zonder aparte client repareert dit alleen de gevallen die het minst
   * voorkomen, en niet de enige die gegarandeerd optreedt.
   */
  herstelClient: GraphClient = client
): BriefingStore {
  const drive = `/sites/${siteId}/drive`;

  const childrenUrl = (pad: string): string =>
    pad === '' ? `${drive}/root/children` : `${drive}/root:/${encodePath(pad)}:/children`;

  /**
   * De kinderen van een map, gefilterd op map of bestand.
   *
   * Een pad dat niet bestaat is hier geen fout maar een antwoord: "er staat niets".
   * `resolve.ts` vraagt met opzet naar mappen die er misschien niet zijn — de jaarmap is
   * optioneel — en die moeten leeg terugkomen in plaats van de hele generatie op te blazen.
   * Andere fouten (403, 500) reizen wél door, want die betekenen iets anders.
   */
  const listNames = async (pad: string, wil: 'folders' | 'files'): Promise<readonly string[]> => {
    try {
      // Alleen `name` en `folder`: de rest van een driveItem is fors en we kijken er niet naar.
      const data = await client.json<{ value: DriveChild[] }>(
        `${childrenUrl(pad)}?$select=name,folder&$top=999`
      );
      const isMap = (kind: DriveChild): boolean => kind.folder !== undefined;
      return data.value
        .filter((kind) => (wil === 'folders' ? isMap(kind) : !isMap(kind)))
        .map((kind) => kind.name);
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) {
        return [];
      }
      throw error;
    }
  };

  return {
    children: (pad) => listNames(pad, 'folders'),
    files: (pad) => listNames(pad, 'files'),

    async find(folderPath, filename) {
      try {
        const item = await herstelClient.json<{
          id: string;
          name: string;
          webUrl: string;
          size?: number;
        }>(`${drive}/root:/${encodePath(`${folderPath}/${filename}`)}?$select=id,name,webUrl,size`);
        return { id: item.id, name: item.name, webUrl: item.webUrl, size: item.size ?? -1 };
      } catch (error) {
        // Niet gevonden is hier een antwoord: de upload heeft het dus écht niet gehaald.
        if (error instanceof GraphError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },

    async createFolder(parentPath, name) {
      try {
        await client.json(childrenUrl(parentPath), {
          method: 'POST',
          body: JSON.stringify({
            name,
            folder: {},
            /**
             * `fail` en niet `rename`, want een botsing is hier informatie.
             *
             * Twee briefings voor dezelfde nieuwe klant kunnen tegelijk genereren; met
             * `rename` levert dat `Klant 1` op naast `Klant`, en dan staat de historie van
             * één klant voorgoed in twee mappen. Falen en de bestaande map gebruiken is het
             * enige antwoord dat bij herhaling hetzelfde resultaat geeft.
             */
            '@microsoft.graph.conflictBehavior': 'fail',
          }),
        });
      } catch (error) {
        // 409: iemand anders was net iets sneller. Dat is precies wat we wilden hebben.
        if (error instanceof GraphError && error.status === 409) {
          return;
        }
        throw error;
      }
    },

    async upload(folderPath, filename, bytes) {
      const pad = encodePath(`${folderPath}/${filename}`);
      /**
       * `conflictBehavior=fail`, want dit is de laatste plek waar overschrijven nog kan.
       *
       * Een padgebaseerde `PUT … /content` maakt óf vervangt de inhoud, en `replace` is de
       * standaard. De vrije versienaam is berekend uit een mappenlijst van een moment
       * eerder, dus twee generaties tegelijk komen allebei op `(v2)` uit en zou de tweede de
       * eerste vervangen — precies de bewerkte briefing die dit hele mechanisme beschermt,
       * en dan op de enige plek waar geen bevestiging meer tussen zit.
       *
       * Botst het, dan krijgt de aanroeper een 409 en kan die opnieuw kijken wat er ligt.
       */
      const item = await client.put(
        `${drive}/root:/${pad}:/content?%40microsoft.graph.conflictBehavior=fail`,
        bytes,
        DOCX_TYPE
      );
      if (
        typeof item !== 'object' ||
        item === null ||
        !('id' in item) ||
        !('webUrl' in item) ||
        !('name' in item)
      ) {
        throw new Error(`Upload van "${filename}" gaf geen bruikbaar antwoord terug`);
      }
      const { id, webUrl, name } = item;
      if (typeof id !== 'string' || typeof webUrl !== 'string' || typeof name !== 'string') {
        throw new Error(`Upload van "${filename}" gaf een onverwacht antwoord terug`);
      }
      return { id, name, webUrl };
    },
  };
}

/**
 * Het site-id bij een host en pad.
 *
 * Apart gehouden omdat het antwoord nooit verandert zolang de site bestaat: één keer per
 * proces ophalen is genoeg, en het scheelt een netwerkronde per briefing.
 */
export async function resolveSiteId(
  client: GraphClient,
  site: { host: string; path: string }
): Promise<string> {
  const data = await client.json<{ id: string }>(`/sites/${site.host}:${site.path}`);
  return data.id;
}
