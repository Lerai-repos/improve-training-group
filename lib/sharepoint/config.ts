/**
 * Wáár de briefings staan. Vastgepind zoals de bord-ids, met een override om tegen een
 * andere site te kunnen draaien zonder de code aan te raken.
 */

/** ITG's eigen Teams-site. Gemeten: de klantmappen staan hier en nergens anders. */
export const ITG_SITE_HOST = 'improvetraininggroup.sharepoint.com';
export const ITG_SITE_PATH = '/sites/ImproveTrainingGroup';

/**
 * De wortel binnen de documentbibliotheek.
 *
 * Dit is een Teams-gekoppelde site, dus de standaardbibliotheek heet `Documents` en het
 * kanaal `General` is daarbinnen gewoon een map. Alle labelmappen hangen eronder.
 */
export const ITG_ROOT_FOLDER = 'General';

export interface SiteConfig {
  readonly host: string;
  readonly path: string;
  readonly root: string;
}

/**
 * `SHAREPOINT_SITE_URL` overschrijft de site, bijvoorbeeld om op een testsite te oefenen.
 *
 * Alles of niets: een half ingevulde override — een host zonder pad — zou stilletjes op de
 * productiesite uitkomen, en dat is precies het soort "test" dat je pas ontdekt als er een
 * briefing in de map van een echte klant staat.
 */
export function siteConfigFromEnv(): SiteConfig {
  const override = process.env.SHAREPOINT_SITE_URL;
  const root = process.env.SHAREPOINT_ROOT_FOLDER ?? ITG_ROOT_FOLDER;
  if (override === undefined || override.trim() === '') {
    return { host: ITG_SITE_HOST, path: ITG_SITE_PATH, root };
  }
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error(`SHAREPOINT_SITE_URL is geen geldige URL: "${override}"`);
  }
  const pad = url.pathname.replace(/\/+$/, '');
  if (pad === '') {
    throw new Error(
      `SHAREPOINT_SITE_URL mist het sitepad (verwacht iets als https://host/sites/Naam): "${override}"`
    );
  }
  return { host: url.host, path: pad, root };
}
