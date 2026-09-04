/**
 * De drie groepen op het Systeem-bord, en waar een rij hoort te staan.
 *
 * De indeling is de hele bedoeling: wie het bord opent moet in één oogopslag zien wat er nog
 * ligt. Staat een afgehandelde melding tussen de openstaande, dan moet je elke regel lezen om
 * te weten of hij er nog toe doet — en dan is een bord met dertig rijen net zo onbruikbaar als
 * geen bord.
 */
export const SIGNAL_GROUPS = {
  /** De doorlopende samenvattingsrij. Eén rij, bovenaan, nooit een melding. */
  samenvatting: 'Laatste controle',
  /** Wat er nog ligt. */
  open: 'Meldingen',
  /** Afgevinkt: opgelost, of door ITG bewust weggezet. */
  afgehandeld: 'Afgehandeld',
} as const;

/** De titels in bordvolgorde, zoals het inrichtingsscript ze neerzet. */
export const SIGNAL_GROUP_ORDER: readonly string[] = [
  SIGNAL_GROUPS.samenvatting,
  SIGNAL_GROUPS.open,
  SIGNAL_GROUPS.afgehandeld,
];

/** De bord-ids van die drie groepen, opgezocht bij het starten van een run. */
export interface SignalGroupIds {
  readonly samenvatting: string;
  readonly open: string;
  readonly afgehandeld: string;
}
