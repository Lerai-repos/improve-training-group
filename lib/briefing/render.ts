/**
 * Het sjabloon kiezen, invullen en een bestandsnaam kiezen.
 *
 * De negen sjablonen in `templates/` zijn gegenereerd uit ITG's `.dotx`-bronnen door
 * `tools/briefing-templates/convert.py`. Ze staan in Git omdat ze mee moeten versioneren
 * met de veldnamen die ze invullen: een sjabloon dat `+++duur+++` verwacht en code die
 * `duurTekst` levert, levert een leeg document op zonder dat er iets faalt.
 */

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createReport } from 'docx-templates';

import type { BriefingDocumentData } from './compose';

/** De delimiters waar de sjablonen op zijn gebouwd. */
const CMD_DELIMITER: [string, string] = ['+++', '+++'];

/** Waar de sjablonen staan, naast dit bestand. */
export const TEMPLATES_DIR = path.join(__dirname, 'templates');

/** Waar de afbeeldingen staan die de blokken kunnen meebrengen. */
export const ASSETS_DIR = path.join(__dirname, 'assets');

/** Breedte van het cyclusschema in de briefing, in centimeters. */
const DIAGRAM_WIDTH_CM = 16;

/**
 * Het sjabloonbestand voor een label.
 *
 * Elk van de negen labels heeft een eigen huisstijl, voorblad en achterblad. Een onbekend
 * label is een `throw` en geen terugval op een standaardsjabloon: dan zou een training van
 * een nieuw label een briefing krijgen met het logo van een ander merk erop.
 */
export function templatePath(label: string, dir: string = TEMPLATES_DIR): string {
  const clean = label.trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(clean)) {
    throw new Error(`Briefing: onbekend label ${JSON.stringify(label)}; geen sjabloon beschikbaar`);
  }
  return path.join(dir, `${clean}.docx`);
}

/**
 * De tekens die Windows en SharePoint weigeren in een bestandsnaam. Een klant als
 * `Gemeente Ede / Wageningen` zou anders een map aanmaken in plaats van een bestand.
 *
 * Spaties en streepjes staan er bewust **niet** bij: ITG schrijft zijn briefings zelf als
 * `Briefing Probiblio - Verbindend communiceren - …`, en dat is de naam die zij herkennen.
 */
const UNSAFE_IN_FILENAME = /[\\/:*?"<>|]/g;

/** `24-03-2026` uit `2026-03-24`; leeg wanneer er geen bruikbare datum is. */
function dateForFilename(isoDatum: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDatum.trim());
  if (match === null) {
    return '';
  }
  return `${match[3]}-${match[2]}-${match[1]}`;
}

/**
 * `Briefing Probiblio - Verbindend communiceren - 24-03-2026 - Lennart Bosschaart.docx`,
 * de naam zoals ITG hem nu zelf schrijft.
 *
 * Lege onderdelen vallen weg in plaats van een dubbel streepje op te leveren, en de hele
 * naam wordt gesaneerd — niet alleen de klantnaam, want een thema of trainersnaam kan er
 * net zo goed een schuine streep in hebben.
 */
export function briefingFilename(input: {
  opdrachtgever: string;
  thema: string;
  isoDatum: string;
  trainers: readonly string[];
}): string {
  const parts = [
    input.opdrachtgever.trim(),
    input.thema.trim(),
    dateForFilename(input.isoDatum),
    input.trainers.map((t) => t.trim()).filter((t) => t !== '').join(', '),
  ].filter((d) => d !== '');
  const name = `Briefing ${parts.join(' - ')}`;
  return `${name.replace(UNSAFE_IN_FILENAME, '-').replace(/\s+/g, ' ').trim()}.docx`;
}

/**
 * Vul het sjabloon van dit label met deze gegevens.
 *
 * `failFast` staat aan, wat de standaard is: valt één veld om, dan is het document fout en
 * moet dat meteen blijken. De alternatieve modus verzamelt fouten en levert tóch een
 * document op, en dat is precies wat hier niet moet gebeuren.
 */
export async function renderBriefing(
  label: string,
  data: BriefingDocumentData,
  options: { templatesDir?: string; assetsDir?: string } = {}
): Promise<Uint8Array> {
  const file = templatePath(label, options.templatesDir);
  const template = await readFile(file);
  const assetsDir = options.assetsDir ?? ASSETS_DIR;
  const gebruikt = new Set<string>();

  /**
   * De afbeelding van één blok, voor het `+++IMAGE blockImage($blk)+++` in het sjabloon.
   *
   * Dit is synchroon omdat `docx-templates` de functie tijdens het renderen aanroept en geen
   * promise terugneemt. De bestanden zijn klein en het zijn er hooguit een paar per document.
   *
   * De hoogte volgt uit de breedte en de werkelijke beeldverhouding: een vaste hoogte zou het
   * cyclusschema uitrekken zodra ITG er een nieuwe versie in zet.
   */
  const blockImage = (blok: { afbeelding?: string }): { width: number; height: number; data: Buffer; extension: string } => {
    const naam = blok.afbeelding;
    if (naam === undefined || naam === '') {
      throw new Error('Briefing: IMAGE aangeroepen voor een blok zonder afbeelding');
    }
    if (!/^[a-z0-9._-]+\.(png|jpg|jpeg)$/i.test(naam)) {
      throw new Error(`Briefing: onveilige of onbekende afbeeldingsnaam ${JSON.stringify(naam)}`);
    }
    const bytes = readFileSync(path.join(assetsDir, naam));
    const verhouding = pngAspectRatio(bytes);
    gebruikt.add(naam);
    return {
      width: DIAGRAM_WIDTH_CM,
      height: DIAGRAM_WIDTH_CM * verhouding,
      data: bytes,
      extension: `.${naam.split('.').pop()!.toLowerCase()}`,
    };
  };

  const buffer = await createReport({
    template,
    data,
    cmdDelimiter: CMD_DELIMITER,
    additionalJsContext: { blockImage },
    /**
     * Verplicht zodra een waarde een `\n` bevat, en dat doen ITG's rolblokken.
     *
     * Standaard staat dit uit, en dan zet `docx-templates` de `<w:br/>` **binnen** de
     * `<w:t>`. Dat is ongeldige OOXML — `w:t` mag alleen tekst bevatten — en de tekst na
     * de afbreking wordt de `tail` van een element dat daar niet hoort te staan. Gemeten
     * 24-Aug-2026: "Jij bent de leadtrainer en dus verantwoordelijk voor:" verdween zo uit
     * het document, terwijl er niets faalde.
     */
    processLineBreaksAsNewText: true,
  });

  /**
   * Een blok dat een afbeelding aankondigt maar er geen kreeg, is een stil defect: het
   * document rendert, alleen ontbreekt het schema. Dat is precies het geval dat niemand ziet
   * tot een trainer de briefing openslaat.
   */
  const verwacht = data.blokken.filter((b) => b.afbeelding !== undefined && b.afbeelding !== '');
  for (const blok of verwacht) {
    if (!gebruikt.has(blok.afbeelding!)) {
      throw new Error(
        `Briefing: het blok "${blok.titel}" hoort de afbeelding ${blok.afbeelding} te tonen, ` +
          'maar het sjabloon heeft die niet opgevraagd. Is het sjabloon opnieuw gegenereerd?'
      );
    }
  }
  return buffer;
}

/** Hoogte gedeeld door breedte, uit de PNG-header. */
function pngAspectRatio(bytes: Buffer): number {
  const PNG_SIGNATURE = '89504e470d0a1a0a';
  if (bytes.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw new Error('Briefing: alleen PNG wordt ondersteund voor blokafbeeldingen');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0) {
    throw new Error('Briefing: afbeelding heeft breedte 0');
  }
  return height / width;
}
