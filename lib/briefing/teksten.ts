/**
 * Een sectie van het bord Briefingteksten, klaar voor het sjabloon.
 *
 * Alleen de pure delen van `@lib/briefingteksten` worden hier geïmporteerd: de tab stelt
 * zijn voorvertoning in de browser samen, en de lezer van het bord hoort niet in die bundel.
 */

import { sectie } from '@lib/briefingteksten/catalog';
import { vulIn } from '@lib/briefingteksten/plaatshouders';
import { standaardTeksten } from '@lib/briefingteksten/teksten';
import { LABEL_SEED, labelSleutel } from '@lib/labels/catalog';

import { notDecided } from './open-issues';

import type {
  BriefingTeksten,
  Plaatshouder,
  TekstRegel,
  TekstSleutel,
} from '@lib/briefingteksten/types';

/** Een sectie met de plaatshouders ingevuld. */
export interface GevuldeSectie {
  readonly kop: string;
  readonly regels: readonly TekstRegel[];
}

/** Wat de briefing zelf invult, naast `{merk}` en `{term}`. */
export type Waarden = Partial<Record<Exclude<Plaatshouder, 'merk' | 'term'>, string>>;

const alinea = (tekst: string): TekstRegel => ({ tekst, bullet: false, niveau: 0 });

/**
 * De zichtbare regel voor een sectie die ITG kapot heeft gemaakt.
 *
 * `nog niet bepaald`, zodat de briefing niet als klaar telt: iemand bij ITG kan het oplossen,
 * en de adviseur ziet het in het document voordat het de deur uit gaat.
 */
export function foutRegel(sleutel: TekstSleutel, melding: string): string {
  return notDecided(
    `de briefingtekst "${sectie(sleutel).naam}"`,
    `${melding} Pas hem aan op het bord Briefingteksten`
  );
}

/**
 * De sectie met alles ingevuld, of `null` als ITG hem leeg liet.
 *
 * `voorbewerking` draait vóór het invullen, op kop en regels. Het cyclusblok gebruikt dat om
 * "van {duur}" weg te laten als de duur niet bekend is.
 */
export function gevuldeSectie(
  teksten: BriefingTeksten,
  sleutel: TekstSleutel,
  waarden: Waarden = {},
  voorbewerking: (tekst: string) => string = (tekst) => tekst
): GevuldeSectie | null {
  const staat = teksten.secties[sleutel];
  if (staat.kind === 'leeg') {
    return null;
  }
  if (staat.kind === 'fout') {
    return { kop: '', regels: [alinea(foutRegel(sleutel, staat.melding))] };
  }
  const alle: Partial<Record<Plaatshouder, string>> = {
    merk: teksten.merk,
    term: teksten.term,
    ...waarden,
  };
  const vul = (tekst: string): string => vulIn(voorbewerking(tekst), alle).trim();
  return {
    kop: vul(staat.kop),
    regels: staat.regels.map((regel) => ({ ...regel, tekst: vul(regel.tekst) })),
  };
}

/**
 * De beginteksten, voor wat een briefing samenstelt zonder hem te versturen: de voorvertoning
 * in de tab en de tests. Merk en term komen dan uit de code in plaats van van het Labels-bord.
 */
export function standaardTekstenVoor(label: string): BriefingTeksten {
  // Op de sleutel: `Feedback Trainer` is de rij `FT` van het begin.
  const seed = LABEL_SEED.find((l) => labelSleutel(l.code) === labelSleutel(label));
  return standaardTeksten({ merk: seed?.volledigeNaam ?? '', term: seed?.term ?? '' });
}
