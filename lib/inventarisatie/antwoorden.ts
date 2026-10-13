/**
 * De antwoorden van het inventarisatieformulier voor één Opportunity, uit de rijen van de sheet.
 *
 * De website geeft `reference_id` door aan het veld "Referentie (niet aanpassen)"; daarop
 * koppelen we. Alle andere kolommen behalve de tijdstempel zijn vragen, en komen integraal in de
 * briefing (`docs/build/06-briefing.md`), in de volgorde van het formulier.
 */

/** Eén vraag en antwoord uit het inventarisatieformulier. */
export interface InventoryAnswer {
  readonly vraag: string;
  readonly antwoord: string;
}

export type InventarisatieAntwoorden =
  | { readonly kind: 'leeg' }
  | {
      readonly kind: 'ingevuld';
      /** De tijdstempel van de inzending, zoals Google hem schrijft. */
      readonly op: string;
      readonly antwoorden: readonly InventoryAnswer[];
    };

/**
 * Wat de briefing van het formulier weet. Hier en niet bij de lezer, zodat de tab dit type kan
 * gebruiken zonder de Google-code in de browserbundel te trekken.
 */
export type InventarisatieStand =
  | InventarisatieAntwoorden
  /** Niet opgevraagd, bijvoorbeeld bij het bevestigen van een cyclus. */
  | { readonly kind: 'niet-gelezen' }
  /** De training hangt aan geen Opportunity, dus er is geen link en geen formulier. */
  | { readonly kind: 'geen-opportunity' }
  /** Opgevraagd en mislukt: dat is iets anders dan "niet ingevuld". */
  | { readonly kind: 'onleesbaar'; readonly fout: string };

/**
 * Google Forms zet soms onzichtbare tekens voor een vraag (U+2060) en spaties erachter. In de
 * briefing hoort de vraag er schoon te staan.
 */
function schoon(tekst: string): string {
  return tekst
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function antwoordenVoor(
  rijen: readonly (readonly string[])[],
  opportunityId: string
): InventarisatieAntwoorden {
  const [kop, ...inzendingen] = rijen;
  if (kop === undefined) {
    throw new Error('Inventarisatiesheet: geen kopregel gevonden.');
  }
  const koppen = kop.map(schoon);
  const referentie = koppen.findIndex((k) => k.toLowerCase().startsWith('referentie'));
  if (referentie === -1) {
    throw new Error(
      'Inventarisatiesheet: geen kolom "Referentie". Zonder die kolom zijn antwoorden niet aan ' +
        'een Opportunity te koppelen.'
    );
  }
  const tijdstempel = koppen.findIndex((k) => k.toLowerCase() === 'tijdstempel');

  /** De laatste, want Google schrijft de inzendingen op volgorde van binnenkomst. */
  const rij = [...inzendingen].reverse().find((r) => (r[referentie] ?? '').trim() === opportunityId);
  if (rij === undefined) {
    return { kind: 'leeg' };
  }
  const antwoorden = koppen.flatMap((vraag, i): InventoryAnswer[] => {
    const antwoord = (rij[i] ?? '').trim();
    return i === referentie || i === tijdstempel || antwoord === '' ? [] : [{ vraag, antwoord }];
  });
  return {
    kind: 'ingevuld',
    op: tijdstempel === -1 ? '' : (rij[tijdstempel] ?? '').trim(),
    antwoorden,
  };
}
