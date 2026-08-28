/**
 * De Monday Challenge-productcodes: van ITG's werkblad naar één cel per thema × label.
 *
 * De code is NIET afleidbaar uit label plus themanummer. "Verbindend communiceren" is IT-58
 * maar JE-60, TT-27, SST-45 en CC-64; er zit geen gedeelde nummering in. Het is dus een
 * opzoektabel, en dit is het stuk dat hem oplost — puur, zodat elk randgeval een test is en
 * geen live bord.
 *
 * De koppeling van naam naar bordthema gebeurt ALLEEN letterlijk of via een met de hand
 * gelegde kaart. Normaliseren is met opzet afwezig: `Klantgericht werken` en
 * `Oplossingsgericht werken` schelen weinig tekens en veel betekenis, en een verkeerde
 * koppeling zet de productcode van een ánder thema in een briefing bij de klant.
 */

/** Themanaam uit het werkblad → labelcode → productcode. */
export type CodesByName = ReadonlyMap<string, ReadonlyMap<string, string>>;

export interface ThemaKaart {
  readonly kaart: Readonly<Record<string, string>>;
  /** Namen waar ITG nog een keuze in moet maken; die schrijven we niet weg. */
  readonly openVraag?: Readonly<Record<string, string>>;
}

/** Twee namen willen dezelfde cel vullen met een verschillende code. */
export interface CodeBotsing {
  readonly thema: string;
  readonly label: string;
  readonly kandidaten: readonly { readonly code: string; readonly via: string }[];
}

export interface CodeResolutie {
  /** Bordthema → labelcode → productcode. Alleen cellen zonder twijfel. */
  readonly perThema: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Cellen die met opzet LEEG blijven omdat er twee codes voor waren. */
  readonly botsingen: readonly CodeBotsing[];
  /** Namen zonder bordthema, of met een openstaande vraag. */
  readonly ongekoppeld: readonly string[];
  /** Cellen waar het werkblad geen code maar een notitie bevat, zoals `NOG MAKEN`. */
  readonly geenCode: readonly {
    readonly thema: string;
    readonly label: string;
    readonly waarde: string;
    readonly via: string;
  }[];
}

/**
 * Hoe een productcode eruitziet: labelprefix, streepje, nummer. `IT-58`, `SST-9`, `TMT-1`.
 *
 * Nodig omdat ITG's werkblad ook NOTITIES in de codekolom heeft staan — `NOG MAKEN` bij
 * `Van eilandjes naar team`, voor een challenge die nog gemaakt moet worden. Dat is geen
 * code, en zonder deze toets belandt die tekst in de gegevenstabel van een klantbriefing.
 */
const CODE = /^[A-Z]{2,4}-\d+$/;

export function isProductCode(waarde: string): boolean {
  return CODE.test(waarde.trim());
}

export function resolveCodes(
  codes: CodesByName,
  kaart: ThemaKaart,
  boardNames: ReadonlySet<string>
): CodeResolutie {
  /** Per cel eerst álle kandidaten verzamelen; pas daarna beslissen. */
  const kandidaten = new Map<string, Map<string, { code: string; via: string }[]>>();
  const ongekoppeld: string[] = [];
  const geenCode: { thema: string; label: string; waarde: string; via: string }[] = [];

  for (const [naam, perLabel] of codes) {
    if (kaart.openVraag?.[naam] !== undefined) {
      ongekoppeld.push(naam);
      continue;
    }
    const doel = boardNames.has(naam) ? naam : kaart.kaart[naam];
    if (doel === undefined || !boardNames.has(doel)) {
      ongekoppeld.push(naam);
      continue;
    }
    const perThema = kandidaten.get(doel) ?? new Map<string, { code: string; via: string }[]>();
    for (const [label, code] of perLabel) {
      if (!isProductCode(code)) {
        // Een notitie in de codekolom is geen code. Melden, niet wegschrijven.
        geenCode.push({ thema: doel, label, waarde: code, via: naam });
        continue;
      }
      perThema.set(label, [...(perThema.get(label) ?? []), { code, via: naam }]);
    }
    kandidaten.set(doel, perThema);
  }

  const perThema = new Map<string, Map<string, string>>();
  const botsingen: CodeBotsing[] = [];

  for (const [thema, perLabel] of kandidaten) {
    for (const [label, lijst] of perLabel) {
      const uniek = [...new Set(lijst.map((k) => k.code))];
      if (uniek.length > 1) {
        /**
         * Botsing: niet kiezen, niet schrijven.
         *
         * De ene code is net zo plausibel als de andere, en een verkeerde staat straks in
         * een document bij de klant zonder dat iets faalt. Een lege cel is zichtbaar onaf.
         */
        botsingen.push({ thema, label, kandidaten: lijst });
        continue;
      }
      const cel = perThema.get(thema) ?? new Map<string, string>();
      cel.set(label, uniek[0]);
      perThema.set(thema, cel);
    }
  }

  return { perThema, botsingen, geenCode, ongekoppeld: [...new Set(ongekoppeld)].sort() };
}

/**
 * De Trainingscode-regel zoals hij in de briefing komt.
 *
 * Drie regels, en alle drie van ITG zelf:
 *
 * - **Meerdere thema's, meerdere codes.** Een training kan aan meer dan één thema hangen en
 *   de gegevenstabel heeft één regel. Ze worden met ` & ` aan elkaar geschreven, dezelfde
 *   scheiding die `composeBriefing` al voor de themanamen gebruikt. Er stilzwijgend één
 *   laten vallen zou de trainer een code geven voor de helft van zijn sessie.
 * - **`-ENG` achter elke code bij een Engelstalige training**, zoals de notitie bovenaan hun
 *   werkblad zegt. Per code, niet achter de hele regel.
 * - **Geen code is een lege regel, geen melding.** 19 van de 100 thema's hebben geen Monday
 *   Challenge en dat is normaal, geen ontbrekende koppeling. ITG vult zelf aan waar er wél
 *   een hoort te komen.
 *
 * **Tweetalig (`NL + ENG`) krijgt ze allebei, met een `/` ertussen:** `IT-58 / IT-58-ENG`.
 * Dirkje, 27-Aug-2026: *"In principe kennen de trainers het principe dat de toevoeging -ENG
 * is, maar als we het toch perfect kunnen opzetten dan zou ik in dit geval beide doen met
 * een / ertussen."* Negen trainingen op het bord staan zo.
 *
 * De twee scheidingstekens betekenen dus verschillende dingen, en dat is met opzet: ` & `
 * scheidt THEMA'S, ` / ` scheidt de taalvarianten van één thema.
 */
export function formatTrainingCode(codes: readonly string[], taal: string): string {
  /**
   * Op inhoud toetsen en niet op gelijkheid, want de kolom is vrije tekst. Live komen `NL`,
   * `ENG`, leeg en `NL + ENG` voor; deze vorm vangt ook `ENG + NL` of `Nederlands/Engels`
   * zonder dat er een lijstje met spellingen bijgehouden moet worden.
   */
  const boven = taal.toUpperCase();
  const engels = boven.includes('ENG');
  const ookNederlands = /\bNL\b|NEDERLANDS/.test(boven);

  return codes
    .map((code) => code.trim())
    .filter((code) => code !== '')
    .map((code) => {
      if (!engels) {
        return code;
      }
      return ookNederlands ? `${code} / ${code}-ENG` : `${code}-ENG`;
    })
    .join(' & ');
}
