/**
 * Een minimale zip-lezer, alleen voor de tests.
 *
 * Een `.docx` is een zip, en om te controleren wát er gerenderd is moeten we erin kijken.
 * Er zit geen zip-bibliotheek in de afhankelijkheden van dit project — `jszip` zit er alleen
 * ónder `docx-templates` en is vanaf de root niet te importeren. Een afhankelijkheid
 * toevoegen voor één test is duurder dan deze dertig regels: we lezen alleen, we hoeven geen
 * zip te schrijven, en zip64 of encryptie komen in een Word-bestand van deze omvang niet voor.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const STORED = 0;
const DEFLATED = 8;

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly localHeaderOffset: number;
}

/** De End of Central Directory staat achteraan, ná een commentaarveld van variabele lengte. */
function findEocd(buffer: Buffer): number {
  for (let at = buffer.length - EOCD_MIN_SIZE; at >= 0; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) {
      return at;
    }
  }
  throw new Error('zip-reader: geen End of Central Directory gevonden');
}

function entries(buffer: Buffer): ZipEntry[] {
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const found: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new Error(`zip-reader: beschadigde central directory bij ingang ${i}`);
    }
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    found.push({
      name: buffer.toString('utf8', at + 46, at + 46 + nameLength),
      method: buffer.readUInt16LE(at + 10),
      compressedSize: buffer.readUInt32LE(at + 20),
      localHeaderOffset: buffer.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

/** Alle bestandsnamen in het archief. */
export function zipNames(bytes: Uint8Array): string[] {
  return entries(Buffer.from(bytes)).map((e) => e.name);
}

/** De inhoud van één bestand, als tekst. */
export function zipReadText(bytes: Uint8Array, name: string): string {
  const buffer = Buffer.from(bytes);
  const entry = entries(buffer).find((e) => e.name === name);
  if (entry === undefined) {
    throw new Error(`zip-reader: ${name} zit niet in het archief`);
  }
  // De naam- en extralengtes van de lokale kop wijken af van die in de central directory.
  const start = entry.localHeaderOffset;
  const nameLength = buffer.readUInt16LE(start + 26);
  const extraLength = buffer.readUInt16LE(start + 28);
  const from = start + 30 + nameLength + extraLength;
  const raw = buffer.subarray(from, from + entry.compressedSize);
  if (entry.method === STORED) {
    return raw.toString('utf8');
  }
  if (entry.method === DEFLATED) {
    return inflateRawSync(raw).toString('utf8');
  }
  throw new Error(`zip-reader: compressiemethode ${entry.method} wordt niet ondersteund`);
}
