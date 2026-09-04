import { SUMMARY_KEY } from './write';

import type { SignalGroupIds } from './groups';
import type { ExistingSignal } from './reconcile';

/** Eén verplaatsing: dit item hoort in die groep. */
export interface GroupMove {
  readonly itemId: string;
  readonly groupId: string;
  /** Alleen voor de logregel — waar hij vandaan komt. */
  readonly from: string;
}

export interface MoveInput {
  readonly existing: readonly ExistingSignal[];
  /** De items die DEZE run zijn afgevinkt; hun `afgehandeld` in `existing` is nog `false`. */
  readonly resolvedIds: readonly string[];
  /** De items die DEZE run zijn heropend; in `existing` staan die nog als afgevinkt. */
  readonly reopenedIds: readonly string[];
  readonly groups: SignalGroupIds;
}

/**
 * Welke rijen naar een andere groep moeten.
 *
 * **Er is óók een Monday-automatisering die dit doet** (4-Sep-2026 door ITG ingesteld op het
 * Systeem-bord: vinkje aan → groep Afgehandeld, vinkje uit → groep Meldingen). Die reageert
 * meteen op een klik; deze functie draait één keer per nacht. Ze spreken elkaar niet tegen —
 * allebei passen ze dezelfde regel toe, dus in het slechtste geval verplaatst de een een rij
 * naar de groep waar hij al staat.
 *
 * **Haal deze functie dus niet weg omdat de automatisering hem overbodig lijkt te maken.** Ze
 * dekken verschillende gaten:
 *
 * | wie vinkt aan | wat verplaatst |
 * |---|---|
 * | een mens, met de hand | de automatisering, meteen |
 * | de controle zelf, als een probleem is opgelost | deze functie, in dezelfde run |
 * | — (automatisering verwijderd of stuk) | deze functie, de eerstvolgende nacht |
 *
 * Die tweede rij is waarom `resolvedIds` bestaat: bij een eigen afvinkactie wachten we niet
 * tot we het vinkje zien staan.
 *
 * Werkt in beide richtingen, en dat is geen extraatje: zet iemand een vinkje per ongeluk en
 * haalt het er weer af, dan moet de melding terug tussen de openstaande. Zonder die tweede
 * richting blijft hij in `Afgehandeld` staan terwijl het vinkje uit is — een rij die op het
 * bord zegt dat hij nog open is, op de plek voor afgeronde dingen. Dat is precies het soort
 * halfslachtige toestand waar niemand meer op vertrouwt.
 *
 * **Rijen zonder sleutel blijven staan waar ze staan.** Die zijn van een mens, niet van ons;
 * iemands eigen aantekening rondschuiven is niet aan de controle.
 */
export function groupMoves(input: MoveInput): readonly GroupMove[] {
  const resolved = new Set(input.resolvedIds);
  const reopened = new Set(input.reopenedIds);
  const moves: GroupMove[] = [];

  for (const signal of input.existing) {
    if (signal.key.trim() === '') {
      continue;
    }

    /**
     * `reopened` wint van `signal.afgehandeld`, want die foto is van vóór de mutaties: de rij
     * stond als afgevinkt in `existing` en is deze run juist ontvinkt.
     */
    const target =
      signal.key === SUMMARY_KEY
        ? input.groups.samenvatting
        : reopened.has(signal.itemId)
          ? input.groups.open
          : signal.afgehandeld || resolved.has(signal.itemId)
            ? input.groups.afgehandeld
            : input.groups.open;

    if (signal.groupId !== target) {
      moves.push({ itemId: signal.itemId, groupId: target, from: signal.groupId });
    }
  }

  return moves;
}

/**
 * Rijen waar `Afgehandeld door` blijft staan terwijl het vinkje eruit is.
 *
 * Hoe dat ontstaat: de controle vinkt af (marker `controle`), en daarna haalt iemand het vinkje
 * er met de hand weer uit. De marker blijft dan staan. Vinkt diezelfde persoon de melding
 * later opnieuw af — nu als bewuste beslissing — dan leest `reconcile` nog steeds "afgevinkt
 * door de controle" en heropent hem tegen hun bedoeling in.
 *
 * Onze eigen heropening zet de marker in dezelfde schrijfactie leeg, dus die rijen staan hier
 * niet bij.
 *
 * **Wat dit niet dicht:** vinkt iemand uit én weer aan tussen twee runs door, dan is de marker
 * bij de volgende run nog niet opgeruimd en wordt de melding één keer ten onrechte heropend.
 * Sluiten vraagt om een webhook op de vinkkolom; deze opruiming verkleint het venster van
 * "voorgoed" naar "één nacht".
 */
export function staleClosedByMarkers(
  existing: readonly ExistingSignal[],
  /** Ids die deze run zijn heropend of afgevinkt — die zijn zojuist al goed gezet. */
  geraakt: { readonly reopenedIds: readonly string[]; readonly resolvedIds: readonly string[] }
): readonly string[] {
  /**
   * **Afgevinkte rijen horen hier net zo goed buiten als heropende.**
   *
   * Een rij kan tegelijk een verouderde marker hebben én deze run worden afgevinkt: het vinkje
   * stond uit (dus de marker is stale) en het probleem is verdwenen (dus we vinken af). `tick`
   * schrijft dan `controle` in de marker — en deze opruiming, die op de foto van vóór de
   * mutaties werkt, zou hem meteen weer leegmaken. De rij leest daarna als "door een mens
   * weggezet" en wordt bij terugkeer van het probleem nooit heropend.
   */
  const raak = new Set([...geraakt.reopenedIds, ...geraakt.resolvedIds]);
  return existing
    .filter((s) => !s.afgehandeld && s.closedByCheck && !raak.has(s.itemId))
    .map((s) => s.itemId);
}
