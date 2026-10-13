import JSZip from 'jszip';

/**
 * Het logo van een label in het algemene sjabloon zetten.
 *
 * Een label zonder eigen sjabloon (ITG voegt ze zelf toe op het Labels-bord) krijgt
 * `_algemeen.docx`. Daarin dragen het logo op het voorblad en dat in de voettekst de relatie-id
 * `rIdLabelLogo` en een leeg plaatje (`tools/briefing-templates/algemeen.py`). Hier gaat het logo
 * van het Labels-bord erin, NA het renderen: `docx-templates` laat afbeeldingen die al in het
 * sjabloon staan ongemoeid, en zo blijft de plek en de verankering van ITG's ontwerp staan.
 *
 * Het vak van het oude logo blijft de grens. Het nieuwe logo wordt daarin zo groot mogelijk
 * gezet met zijn eigen verhouding, links boven, zodat een vierkant logo niet uitgerekt wordt tot
 * een balk.
 */

export const LOGO_RELATIE = 'rIdLabelLogo';

export type LogoSoort = 'png' | 'jpeg';

export interface LabelLogo {
  readonly bytes: Uint8Array;
  readonly soort: LogoSoort;
  /** In pixels; alleen de verhouding telt. */
  readonly breedte: number;
  readonly hoogte: number;
}

const PNG_HANDTEKENING = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Breedte en hoogte staan in de IHDR, direct na handtekening, lengte en type. */
const PNG_BREEDTE = 16;
const PNG_HOOGTE = 20;
const PNG_MIN = 24;

const JPEG_START = [0xff, 0xd8];
/** De SOF-markers die een afmeting dragen: alles van C0 tot CF behalve C4, C8 en CC. */
const GEEN_SOF = new Set([0xc4, 0xc8, 0xcc]);
const SOF_EERSTE = 0xc0;
const SOF_LAATSTE = 0xcf;

const begintMet = (bytes: Uint8Array, kop: readonly number[]): boolean =>
  kop.every((b, i) => bytes[i] === b);

const uint16 = (bytes: Uint8Array, at: number): number => (bytes[at] << 8) | bytes[at + 1];
const uint32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];

function jpegAfmeting(bytes: Uint8Array): { breedte: number; hoogte: number } | null {
  let at = JPEG_START.length;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      return null;
    }
    const marker = bytes[at + 1];
    const lengte = uint16(bytes, at + 2);
    if (marker >= SOF_EERSTE && marker <= SOF_LAATSTE && !GEEN_SOF.has(marker)) {
      // Lengte (2), precisie (1), dan hoogte en breedte.
      return at + 9 <= bytes.length
        ? { hoogte: uint16(bytes, at + 5), breedte: uint16(bytes, at + 7) }
        : null;
    }
    at += 2 + lengte;
  }
  return null;
}

/**
 * Het bestand van het Labels-bord als logo, of een fout die zegt wat er mis is.
 *
 * Alleen PNG en JPEG: dat zijn de twee die Word zonder omweg toont en die het sjabloon al kent.
 * Op de inhoud en niet op de bestandsnaam, want een naam is vrije tekst.
 */
export function leesLogo(bytes: Uint8Array, naam: string): LabelLogo {
  if (bytes.length >= PNG_MIN && begintMet(bytes, PNG_HANDTEKENING)) {
    const breedte = uint32(bytes, PNG_BREEDTE);
    const hoogte = uint32(bytes, PNG_HOOGTE);
    if (breedte > 0 && hoogte > 0) {
      return { bytes, soort: 'png', breedte, hoogte };
    }
  } else if (begintMet(bytes, JPEG_START)) {
    const maat = jpegAfmeting(bytes);
    if (maat !== null && maat.breedte > 0 && maat.hoogte > 0) {
      return { bytes, soort: 'jpeg', ...maat };
    }
  }
  throw new Error(
    `Logo "${naam}" is geen leesbare PNG of JPEG. Zet op het Labels-bord een logo als PNG of JPEG.`
  );
}

/** Binnen het vak van `vak` (EMU), met de verhouding van het logo. */
export function pasIn(
  vak: { readonly cx: number; readonly cy: number },
  logo: Pick<LabelLogo, 'breedte' | 'hoogte'>
): { readonly cx: number; readonly cy: number } {
  const verhouding = logo.breedte / logo.hoogte;
  return vak.cx / vak.cy > verhouding
    ? { cx: Math.round(vak.cy * verhouding), cy: vak.cy }
    : { cx: vak.cx, cy: Math.round(vak.cx / verhouding) };
}

const DRAWING = /<w:drawing>[\s\S]*?<\/w:drawing>/g;
const EXTENT = /<wp:extent cx="(\d+)" cy="(\d+)"\s*\/>/;
/**
 * De afmeting van het plaatje zelf, in DrawingML. Met elk voorvoegsel: `convert.py` schrijft de
 * sjablonen opnieuw weg met ElementTree, en dat maakt van `a:` een `ns5:`.
 */
const A_EXT = /<(\w+):ext cx="\d+" cy="\d+"\s*\/>/;

/** Elke tekening met het logo, met het nieuwe formaat in plaats van het oude vak. */
function schaalTekeningen(xml: string, logo: LabelLogo, onderdeel: string): string {
  let gevonden = 0;
  const uit = xml.replace(DRAWING, (tekening) => {
    if (!tekening.includes(`r:embed="${LOGO_RELATIE}"`)) {
      return tekening;
    }
    gevonden += 1;
    const extent = EXTENT.exec(tekening);
    if (extent === null || !A_EXT.test(tekening)) {
      throw new Error(`Algemeen sjabloon: het logo in ${onderdeel} heeft geen afmeting.`);
    }
    const maat = pasIn({ cx: Number(extent[1]), cy: Number(extent[2]) }, logo);
    return tekening
      .replace(EXTENT, `<wp:extent cx="${maat.cx}" cy="${maat.cy}"/>`)
      .replace(
        A_EXT,
        (_, voorvoegsel: string) => `<${voorvoegsel}:ext cx="${maat.cx}" cy="${maat.cy}"/>`
      );
  });
  if (gevonden === 0) {
    throw new Error(`Algemeen sjabloon: ${onderdeel} verwijst naar het logo maar toont het niet.`);
  }
  return uit;
}

const RELATIE = new RegExp(`<Relationship [^>]*Id="${LOGO_RELATIE}"[^>]*/>`);
const TARGET = /Target="([^"]+)"/;

const CONTENT_TYPE: Readonly<Record<LogoSoort, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
};

/**
 * Het gerenderde document met het logo van het label erin.
 *
 * Werpt als het document geen logoplek heeft: dan is het niet uit het algemene sjabloon
 * gemaakt, en zonder logo de deur uit gaan is precies wat dit moet voorkomen.
 */
export async function metLogo(docx: Uint8Array, logo: LabelLogo): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(docx);
  const relsBestanden = Object.keys(zip.files).filter((n) => /^word\/_rels\/[^/]+\.rels$/.test(n));

  let vervangen = 0;
  for (const relsPad of relsBestanden) {
    const rels = await zip.file(relsPad)?.async('string');
    const relatie = rels === undefined ? null : RELATIE.exec(rels);
    if (rels === undefined || relatie === null) {
      continue;
    }
    const doel = TARGET.exec(relatie[0])?.[1];
    if (doel === undefined) {
      throw new Error(`Algemeen sjabloon: ${relsPad} heeft een logorelatie zonder doel.`);
    }
    const onderdeel = relsPad.replace('_rels/', '').replace(/\.rels$/, '');
    const xml = await zip.file(onderdeel)?.async('string');
    if (xml === undefined) {
      throw new Error(`Algemeen sjabloon: ${onderdeel} ontbreekt.`);
    }

    const nieuwDoel = doel.replace(/\.[a-z]+$/, `.${logo.soort}`);
    zip.remove(`word/${doel}`);
    zip.file(`word/${nieuwDoel}`, logo.bytes);
    zip.file(
      relsPad,
      rels.replace(relatie[0], relatie[0].replace(TARGET, `Target="${nieuwDoel}"`))
    );
    zip.file(onderdeel, schaalTekeningen(xml, logo, onderdeel));
    vervangen += 1;
  }
  if (vervangen === 0) {
    throw new Error('Algemeen sjabloon: geen plek voor het logo gevonden.');
  }

  const typesPad = '[Content_Types].xml';
  const types = await zip.file(typesPad)?.async('string');
  if (types === undefined) {
    throw new Error('Algemeen sjabloon: [Content_Types].xml ontbreekt.');
  }
  if (!types.includes(`Extension="${logo.soort}"`)) {
    zip.file(
      typesPad,
      types.replace(
        /(<Types[^>]*>)/,
        `$1<Default Extension="${logo.soort}" ContentType="${CONTENT_TYPE[logo.soort]}"/>`
      )
    );
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
