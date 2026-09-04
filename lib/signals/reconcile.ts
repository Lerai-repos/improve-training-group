import type { DesiredRow } from './types';

/** Een melding zoals die nu op het Systeem-bord staat. */
export interface ExistingSignal {
  readonly itemId: string;
  /**
   * De itemnaam zoals die er staat.
   *
   * Dit is de vergelijkingswaarde voor "is er iets veranderd?". Elke variant van
   * `findingName` draagt zijn veranderlijke gegevens in de naam — het aantal trainingen, of
   * welke velden leeg zijn — dus een naam die afwijkt van wat we nú zouden schrijven betekent
   * dat de situatie is verschoven.
   */
  readonly naam: string;
  /** Uit de kolom Sleutel. Leeg voor een rij die een mens zelf heeft aangemaakt. */
  readonly key: string;
  readonly afgehandeld: boolean;
  /** De huidige inhoud van Detail, zodat het afvinken er een regel voor kan zetten. */
  readonly detail: string;
  /** In welke groep de rij nu staat — zie `move.ts`. */
  readonly groupId: string;
  /** Uit `Afgehandeld door`: heeft de controle zelf afgevinkt, of een mens? */
  readonly closedByCheck: boolean;
}

export type SignalAction =
  | { readonly kind: 'create'; readonly row: DesiredRow }
  /** Staat er al en staat open, maar de cijfers of de lege velden zijn verschoven. */
  | { readonly kind: 'update'; readonly signal: ExistingSignal; readonly row: DesiredRow }
  /** Was door de controle zelf afgevinkt, en is nu terug. */
  | { readonly kind: 'reopen'; readonly signal: ExistingSignal; readonly row: DesiredRow }
  /**
   * Draagt de hele melding mee en niet alleen het id: het afvinken zet een regel boven het
   * bestaande Detail, en dan is een tweede leesronde voor die tekst zonde en fragiel.
   */
  | { readonly kind: 'resolve'; readonly signal: ExistingSignal };

export interface ReconcileInput {
  /** Alles wat er ná deze run op het bord hoort te staan: vondsten én mislukte controles. */
  readonly rows: readonly DesiredRow[];
  readonly existing: readonly ExistingSignal[];
  /**
   * De soorten waarvan de controle deze run daadwerkelijk IS gelukt.
   *
   * Dit is de belangrijkste parameter van deze functie. Zonder hem zou een controle die
   * afbreekt — het Labels-bord onbereikbaar, een time-out — nul vondsten opleveren, en zou de
   * opruimstap daaruit concluderen dat álles is opgelost en elke openstaande melding afvinken.
   * Het bord zou dan schoon zijn op precies het moment dat we het minst weten.
   */
  /**
   * Elk item dekt óf een hele soort (de prefix vóór de `:`) óf één rij (de volledige sleutel).
   *
   * Die tweede vorm bestaat voor de storingsrijen. Een controle die niet eens geprobeerd is —
   * omdat de agenda al niet gelezen kon worden — mag niet meeliften op een prefix die zegt
   * "alle storingsrijen zijn beoordeeld". Anders vinkt deze run de storingsrij van gisteren af
   * zonder dat die controle ooit is gedraaid, en meldt het bord herstel dat niemand heeft
   * vastgesteld.
   */
  readonly checked: readonly string[];
}

const kindOf = (key: string): string => key.split(':')[0] ?? '';

/** Mag deze run een uitspraak doen over deze sleutel? Prefix dekt de soort, sleutel de rij. */
const inScope = (checked: ReadonlySet<string>, key: string): boolean =>
  checked.has(kindOf(key)) || checked.has(key);

/**
 * Wat er op het bord moet gebeuren.
 *
 * Eén sleutel is één rij — er komt nooit een tweede rij voor hetzelfde probleem bij. Wat er
 * met die ene rij gebeurt hangt af van zijn toestand:
 *
 * | staat op het bord | vondst nu | wat er gebeurt |
 * |---|---|---|
 * | open, zelfde naam | ja | niets |
 * | open, andere naam | ja | **update** — de cijfers zijn verschoven |
 * | open | nee | **resolve** — opgelost, wij vinken af |
 * | afgevinkt dóór de controle | ja | **reopen** — het is terug |
 * | afgevinkt door een MENS | ja | niets — bewust weggezet, dat respecteren we |
 * | afgevinkt, welke dan ook | nee | niets |
 *
 * **Die vijfde regel tegenover de vierde is de kern.** Vinkt ITG "Massages" weg omdat dat thema
 * nooit briefinginhoud krijgt, dan hoort dat voorgoed stil te blijven. Vinken wíj af omdat het
 * probleem wég was, en komt het terug, dan is dat nieuwe informatie en hoort het bord dat te
 * zeggen. Zonder dat onderscheid kiest de opzet één van beide fouten: eeuwig ruis, of een
 * probleem dat één keer is opgelost en daarna nooit meer gemeld wordt.
 *
 * Alles hierboven geldt **alleen binnen een geslaagde controle**, zie `checked`.
 *
 * Een rij zonder sleutel, of met een sleutel die we niet kennen, blijft ongemoeid. Dat is
 * iemands eigen aantekening op het bord en niet van ons.
 */
export function reconcile(input: ReconcileInput): readonly SignalAction[] {
  const checked = new Set<string>(input.checked);
  const actions: SignalAction[] = [];

  const wanted = new Map<string, DesiredRow>();
  for (const row of input.rows) {
    if (wanted.has(row.key)) {
      throw new Error(
        `Twee rijen met dezelfde sleutel "${row.key}". Dat kan niet: één sleutel is één rij op ` +
          'het bord, dus de tweede zou de eerste stilzwijgend verdringen.'
      );
    }
    if (!inScope(checked, row.key)) {
      throw new Error(
        `Rij met sleutel "${row.key}" terwijl die soort niet als geslaagd is gemeld. Zet de ` +
          'soort in `checked`, anders wordt de melding wel geplaatst maar nooit opgeruimd.'
      );
    }
    wanted.set(row.key, row);
  }

  const onBoard = new Map<string, ExistingSignal>();
  for (const signal of input.existing) {
    if (signal.key.trim() !== '') {
      onBoard.set(signal.key, signal);
    }
  }

  for (const [key, row] of wanted) {
    const signal = onBoard.get(key);
    if (signal === undefined) {
      actions.push({ kind: 'create', row });
      continue;
    }
    if (signal.afgehandeld) {
      // Alleen terugzetten wat de controle zélf had afgevinkt; een mens die iets wegzet
      // heeft een reden, en die overrulen we niet.
      if (signal.closedByCheck) {
        actions.push({ kind: 'reopen', signal, row });
      }
      continue;
    }
    /**
     * Vergelijken op de NAAM en niet op het Detail.
     *
     * De naam is van ons: elke variant zet er zijn veranderlijke gegevens in, en niemand heeft
     * reden hem te bewerken. Het Detail is waar iemand een aantekening achterlaat, en dáárop
     * vergelijken zou betekenen dat we elke nacht zijn tekst terugzetten.
     *
     * Bij een echte verschuiving wordt het Detail wél meegeschreven — het noemt de aantallen
     * en de lege velden, en die laten staan is misleidender dan een overschreven notitie.
     */
    const veranderd =
      signal.naam !== row.naam || (row.refreshDetail && signal.detail !== row.detail);
    if (veranderd) {
      actions.push({ kind: 'update', signal, row });
    }
  }

  for (const signal of onBoard.values()) {
    if (signal.afgehandeld) {
      continue;
    }
    if (!inScope(checked, signal.key)) {
      continue;
    }
    if (!wanted.has(signal.key)) {
      actions.push({ kind: 'resolve', signal });
    }
  }

  return actions;
}
