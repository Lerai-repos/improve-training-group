import { sectieVoor } from './catalog';
import { controleerPlaatshouders } from './plaatshouders';
import { parseKop, parseRegels } from './regels';

import type { SectieDefinitie, SectieStaat, TekstStatus } from './types';

/** Eén item op het bord, zoals de lezer het teruggeeft. */
export interface TekstRij {
  readonly itemId: string;
  readonly naam: string;
  readonly sleutel: string;
  readonly kop: string;
  readonly tekst: string;
  /** Wat er nu in Status staat; leeg als er niets staat. */
  readonly status: string;
  readonly melding: string;
}

/** Het oordeel over één item: wat er in Status en Melding hoort, en wat de briefing ermee doet. */
export interface Oordeel {
  readonly status: TekstStatus;
  readonly melding: string;
  /** `null` voor een item dat niet bij een sectie hoort: dat doet in de briefing niets. */
  readonly definitie: SectieDefinitie | null;
  readonly staat: SectieStaat;
}

const NIET_GEKOPPELD =
  'Dit item hoort bij geen enkele sectie en wordt niet gebruikt. Nieuwe secties kunnen niet ' +
  'via het bord worden toegevoegd.';

/**
 * Keurt één item.
 *
 * `dubbel` is waar de aanroeper zegt dat een tweede item dezelfde sleutel heeft. Dat gebeurt
 * vanzelf bij "Dupliceren" in Monday, want dat kopieert de Sleutel mee. Welke van de twee
 * bedoeld is valt niet te raden, dus zijn ze allebei fout tot er één weg is.
 */
export function beoordeel(rij: TekstRij, dubbel: boolean): Oordeel {
  const definitie = sectieVoor(rij.sleutel);
  if (definitie === null) {
    return {
      status: 'Niet gekoppeld',
      melding: NIET_GEKOPPELD,
      definitie: null,
      staat: { kind: 'leeg' },
    };
  }
  const fout = (melding: string): Oordeel => ({
    status: 'Fout',
    melding,
    definitie,
    staat: { kind: 'fout', melding },
  });

  if (dubbel) {
    return fout(
      `"${definitie.naam}" staat meer dan één keer op het bord (zelfde Sleutel). Verwijder ` +
        'de items die je niet wilt gebruiken.'
    );
  }

  const regels = parseRegels(rij.tekst);
  if (regels.length === 0) {
    return {
      status: 'Leeg',
      melding: 'Tekst is leeg, dus deze sectie staat niet in de briefing.',
      definitie,
      staat: { kind: 'leeg' },
    };
  }

  const kop = parseKop(rij.kop);
  if (!definitie.heeftKop && kop !== '') {
    return fout('Deze sectie heeft geen kop. Maak Kop leeg.');
  }
  const probleem =
    controleerPlaatshouders(kop, definitie.plaatshouders) ??
    controleerPlaatshouders(rij.tekst, definitie.plaatshouders);
  if (probleem !== null) {
    return fout(probleem);
  }

  return { status: 'OK', melding: '', definitie, staat: { kind: 'tekst', kop, regels } };
}

/** Alle items tegelijk, zodat een dubbele sleutel bij beide items wordt gezien. */
export function beoordeelAlle(
  rijen: readonly TekstRij[]
): ReadonlyArray<{ readonly rij: TekstRij; readonly oordeel: Oordeel }> {
  const aantal = new Map<string, number>();
  for (const rij of rijen) {
    const sleutel = rij.sleutel.trim();
    if (sectieVoor(sleutel) !== null) {
      aantal.set(sleutel, (aantal.get(sleutel) ?? 0) + 1);
    }
  }
  return rijen.map((rij) => ({
    rij,
    oordeel: beoordeel(rij, (aantal.get(rij.sleutel.trim()) ?? 0) > 1),
  }));
}
