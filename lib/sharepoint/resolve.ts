import {
  sanitiseItemName,
  matchClientFolder,
  matchKlantenFolder,
  matchLabelFolder,
  matchYearFolder,
  type FolderMatch,
} from './paths';

/**
 * Van een training naar de map waar zijn briefing hoort.
 *
 * De mappen worden opgevraagd via {@link FolderLister}, zodat deze hele beslissing te
 * testen is zonder SharePoint. Wat hier gebeurt is precies één ding: uitrekenen wáár het
 * bestand heen gaat, en weigeren als dat niet vast te stellen is.
 */

export interface FolderLister {
  /** De namen van de mappen direct onder dit pad, relatief aan de wortel van de bibliotheek. */
  children(path: string): Promise<readonly string[]>;
}

export interface BriefingLocation {
  /** Het volledige pad van de klantmap. */
  readonly path: string;
  /** False als de map nog gemaakt moet worden. */
  readonly exists: boolean;
}

export type LocationResult =
  | { readonly kind: 'ok'; readonly location: BriefingLocation }
  | { readonly kind: 'refused'; readonly reason: string };

export interface LocationInput {
  /** De wortel binnen de bibliotheek — bij ITG het Teams-kanaal `General`. */
  readonly root: string;
  /** Het label van de training, bijvoorbeeld `TT`. */
  readonly label: string;
  /** De klantnaam zoals Monday hem heeft. */
  readonly klant: string;
  /** Het jaar van de SESSIE, of null als de training geen bruikbare datum heeft. */
  readonly jaar: string | null;
}

const join = (...delen: readonly string[]): string => delen.filter((d) => d !== '').join('/');

/**
 * Een niveau waar we niets mogen verzinnen.
 *
 * Label- en klantenmappen dragen een nummer dat bij ITG's eigen indeling hoort — `10. ST`,
 * `05. klanten`. Zelf een `16. XYZ` aanmaken zou een map opleveren die eruitziet alsof hij
 * bij hun systeem hoort terwijl wij hem hebben verzonnen. Ontbreekt hij, dan is er iets aan
 * hun structuur veranderd en dat hoort iemand te weten.
 */
function vereis(match: FolderMatch, wat: string, pad: string): string | { reason: string } {
  if (match.kind === 'found') {
    return match.name;
  }
  if (match.kind === 'ambiguous') {
    return {
      reason: `Meerdere mappen heten ${wat} in "${pad}" (${match.names.join(', ')}). Ruim er één op; ik gok hier niet tussen.`,
    };
  }
  return {
    reason: `Geen map ${wat} gevonden in "${pad}". Als de structuur is gewijzigd, laat het weten — ik maak deze map niet zelf aan, want het nummer ervoor hoort bij jullie indeling.`,
  };
}

export async function resolveBriefingLocation(
  lister: FolderLister,
  input: LocationInput
): Promise<LocationResult> {
  /**
   * Geen klantnaam, geen bestemming — en dit moet vóór alles.
   *
   * `join` laat lege segmenten weg, dus een lege klantnaam levert geen pad naar een
   * klantmap op maar het pad van de map eróver: de jaarmap, of anders de klantenmap zelf.
   * Die bestaat al, dus er wordt niets aangemaakt, er faalt niets, en de briefing komt
   * tussen de mappen van alle andere klanten van dat label te staan. Van alle manieren
   * waarop dit mis kan gaan is dat de enige die niemand ziet.
   *
   * Leeg is hier geen theoretisch geval: `opdrachtgever` is een spiegel van de gekoppelde
   * Opportunity, en op het echte bord hebben 10 van de 264 komende trainingen er geen. Het
   * item ziet er dan volledig ingevuld uit — de naam noemt de klant gewoon — en de tab meldt
   * de lege cel bewust zonder te blokkeren, omdat het in het document een «…»-regel wordt.
   * Dat is de juiste keuze voor een regel tekst en de verkeerde voor een pad.
   */
  if (sanitiseItemName(input.klant) === '') {
    return {
      kind: 'refused',
      reason:
        'Deze training heeft geen Opdrachtgever, dus er is geen klantmap om de briefing in te zetten. ' +
        'Meestal komt dat doordat er geen Opportunity aan de training gekoppeld is.',
    };
  }

  const labelMatch = matchLabelFolder(await lister.children(input.root), input.label);
  const labelNaam = vereis(labelMatch, `voor label "${input.label}"`, input.root);
  if (typeof labelNaam !== 'string') {
    return { kind: 'refused', reason: labelNaam.reason };
  }
  const labelPad = join(input.root, labelNaam);

  const klantenMatch = matchKlantenFolder(await lister.children(labelPad));
  const klantenNaam = vereis(klantenMatch, '"Klanten"', labelPad);
  if (typeof klantenNaam !== 'string') {
    return { kind: 'refused', reason: klantenNaam.reason };
  }
  const klantenPad = join(labelPad, klantenNaam);

  const onderKlanten = await lister.children(klantenPad);

  /**
   * De jaarmap is optioneel, en dat is het hele punt.
   *
   * Onder TT staat alles in jaarmappen, onder JE alleen het archief. Beide werken, en zodra
   * er onder JE een `2026` verschijnt gebruiken we die vanzelf. Een verplichte jaarmap zou
   * betekenen dat onze functie stuk is totdat iemand anders opruimt.
   */
  const jaarMatch = input.jaar === null ? null : matchYearFolder(onderKlanten, input.jaar);
  if (jaarMatch?.kind === 'ambiguous') {
    return {
      kind: 'refused',
      reason: `Meerdere mappen heten "${input.jaar}" in "${klantenPad}" (${jaarMatch.names.join(', ')}).`,
    };
  }
  const jaarPad = jaarMatch?.kind === 'found' ? join(klantenPad, jaarMatch.name) : null;

  /**
   * Eerst zoeken op álle plekken waar de klant kan staan, dan pas aanmaken.
   *
   * Op een half opgeruimd label bestaat de klantmap los onder `Klanten` terwijl er al een
   * jaarmap is. Meteen in de jaarmap aanmaken zou een tweede map voor dezelfde klant
   * opleveren, naast degene met de hele historie erin — en dat is de map waar iedereen een
   * link naartoe heeft staan.
   */
  const inJaar =
    jaarPad === null ? null : matchClientFolder(await lister.children(jaarPad), input.klant);
  const inKlanten = matchClientFolder(onderKlanten, input.klant);

  for (const [match, pad] of [
    [inJaar, jaarPad],
    [inKlanten, klantenPad],
  ] as const) {
    if (match?.kind === 'ambiguous' && pad !== null) {
      return {
        kind: 'refused',
        reason: `Meerdere mappen lijken op "${input.klant}" in "${pad}" (${match.names.join(', ')}). Ruim er één op; ik gok hier niet tussen.`,
      };
    }
  }

  // Staat hij in beide, dan wint de jaarmap: dat is de indeling waar ITG naartoe wil.
  if (inJaar?.kind === 'found' && jaarPad !== null) {
    return { kind: 'ok', location: { path: join(jaarPad, inJaar.name), exists: true } };
  }
  if (inKlanten.kind === 'found') {
    return { kind: 'ok', location: { path: join(klantenPad, inKlanten.name), exists: true } };
  }

  /**
   * Nergens gevonden, dus aanmaken — mét Monday's eigen schrijfwijze.
   *
   * Dit is het niveau zónder nummer, dus er valt niets te verzinnen: de map heet zoals de
   * klant heet. En als het een dubbele blijkt door een typefout op het bord, dan staat er
   * een overbodige map die iemand in tien seconden opruimt. Dat is de goedkope kant van de
   * fout; in de map van een ándere klant schrijven is dat niet.
   */
  const doelPad = jaarPad ?? klantenPad;
  return {
    kind: 'ok',
    // Gesaneerd: een klant als `Gemeente Ede / Wageningen` zou anders geen map opleveren
    // maar twee, genest. Zie `sanitiseItemName`.
    location: { path: join(doelPad, sanitiseItemName(input.klant)), exists: false },
  };
}
