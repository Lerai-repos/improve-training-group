import { labelSleutel } from '@lib/labels';
import { readLabelRows } from '@lib/labels/read';
import { fetchAsset } from '@lib/report/assets';

import { leesLogo } from './logo';

import type { LabelLogo } from './logo';

/** Wat dit van een Monday-client gebruikt; de echte client past er zonder cast in. */
type LabelsClient = Parameters<typeof readLabelRows>[0];

/**
 * Het logo van een label, van zijn rij op het Labels-bord, voor het algemene briefingsjabloon.
 *
 * Werpt in plaats van zonder logo door te gaan: een briefing zonder merk, of met het lege
 * plaatje uit het sjabloon, gaat naar een trainer zonder dat iemand het ziet. De melding zegt
 * welk veld ITG moet vullen.
 */
export async function haalLabelLogo(
  client: LabelsClient,
  labelsBoardId: string,
  label: string
): Promise<LabelLogo> {
  const { records } = await readLabelRows(client, labelsBoardId);
  const rij = records.find((r) => labelSleutel(r.code) === labelSleutel(label));
  if (rij === undefined) {
    throw new Error(`Labels-bord: geen rij voor ${label.trim()}, dus geen logo voor de briefing.`);
  }
  if (rij.logo === null) {
    throw new Error(
      `Labels-bord: bij ${rij.code} is Logo leeg. Een label zonder eigen sjabloon krijgt dat ` +
        'logo op de briefing; zet er een PNG of JPEG in.'
    );
  }
  const opgehaald = await fetchAsset(rij.logo);
  if (opgehaald.kind === 'failed') {
    throw new Error(
      `Labels-bord: het logo van ${rij.code} is niet op te halen (${opgehaald.reason}).`
    );
  }
  return leesLogo(new Uint8Array(opgehaald.bytes), rij.logo.name);
}
