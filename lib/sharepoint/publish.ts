import { GraphError } from './graph';
import { resolveBriefingLocation } from './resolve';
import { alreadyExists, nextVersionName, relatedBriefings } from './versions';

import type { SiteConfig } from './config';
import type { BriefingStore, UploadedFile } from './store';

/**
 * Briefings wegschrijven, in twee stappen.
 *
 * **Plannen** kijkt alleen: waar hoort het, en ligt er al iets? Het maakt niets aan en
 * schrijft niets. **Schrijven** doet het werk, en vereist dat de adviseur een bestaande
 * briefing bewust heeft bevestigd.
 *
 * Die splitsing is er om twee redenen. Eén training levert tot acht documenten op, en de
 * adviseur hoort één keer bevestigd te worden gevraagd in plaats van acht keer. En op deze
 * manier bestáát er geen codepad dat een bewerkte briefing overschrijft: de naam wordt bij
 * het schrijven opgehoogd, nooit hergebruikt.
 *
 * Het renderen staat hierbuiten. Dit krijgt de bytes en hoeft niets van sjablonen te weten,
 * zodat straks een offerte of programmablad langs dezelfde weg kan.
 */

export interface BriefingDocument {
  /** De gewenste naam; wordt opgehoogd als die al bezet is. */
  readonly filename: string;
  readonly bytes: Uint8Array;
}

export interface PlanInput {
  readonly label: string;
  readonly klant: string;
  /** Het jaar van de sessie, of null bij een training zonder datum. */
  readonly jaar: string | null;
  /** De namen die we zouden willen schrijven, één per ontvanger. */
  readonly filenames: readonly string[];
}

export interface BriefingPlan {
  readonly folderPath: string;
  /** False als de klantmap bij het schrijven nog aangemaakt moet worden. */
  readonly folderExists: boolean;
  /** Namen die precies zo al bestaan. Hierop hangt de bevestiging. */
  readonly conflicts: readonly string[];
  /**
   * Alle briefings van deze training die er al liggen, inclusief eerdere versies.
   *
   * Ruimer dan `conflicts` met opzet: verschuift de datum, dan verandert de bestandsnaam en
   * botst er niets, terwijl de bewerkte briefing van de oude datum blijft staan. Die is dan
   * hier zichtbaar, zodat de adviseur zelf ziet dat er iets weg moet.
   */
  readonly related: readonly string[];
}

export type PlanResult =
  | { readonly kind: 'ok'; readonly plan: BriefingPlan }
  /**
   * Geweigerd, niet mislukt. Er is niets kapot: ITG's mappen zien er anders uit dan we
   * verwachten, en de tekst zegt wat eraan te doen is. Een `throw` zou dit op één hoop
   * gooien met een netwerkstoring, terwijl opnieuw proberen hier nooit helpt.
   */
  | { readonly kind: 'refused'; readonly reason: string };

export async function planBriefings(
  store: BriefingStore,
  site: SiteConfig,
  input: PlanInput
): Promise<PlanResult> {
  const plek = await resolveBriefingLocation(store, {
    root: site.root,
    label: input.label,
    klant: input.klant,
    jaar: input.jaar,
  });
  if (plek.kind === 'refused') {
    return { kind: 'refused', reason: plek.reason };
  }

  const { path, exists } = plek.location;
  // Een map die nog niet bestaat heeft per definitie niets in zich; dat scheelt een aanroep.
  const bestaande = exists ? await store.files(path) : [];

  const related = new Set<string>();
  for (const naam of input.filenames) {
    for (const gevonden of relatedBriefings(naam, bestaande)) {
      related.add(gevonden);
    }
  }

  return {
    kind: 'ok',
    plan: {
      folderPath: path,
      folderExists: exists,
      conflicts: input.filenames.filter((naam) => alreadyExists(naam, bestaande)),
      related: [...related],
    },
  };
}

export interface WrittenBriefing {
  /** De naam die gevraagd werd. */
  readonly requested: string;
  readonly file: UploadedFile;
  /** True als er naast een bestaande briefing is geschreven in plaats van erop. */
  readonly versioned: boolean;
}

export class UnconfirmedOverwrite extends Error {
  constructor(readonly conflicts: readonly string[]) {
    super(`Er ligt al een briefing (${conflicts.join(', ')}) en dat is niet bevestigd`);
    this.name = 'UnconfirmedOverwrite';
  }
}

/**
 * Een eigen uitkomst, en niet `PlanResult` hergebruiken.
 *
 * `planBriefings` geeft ook `kind: 'ok'` terug, maar met een `plan` erin. Zou schrijven
 * datzelfde woord gebruiken, dan zijn de twee niet uit elkaar te halen en moet elke
 * aanroeper gokken welke van de twee hij in handen heeft. `written` zegt wat er is gebeurd.
 */
export type WriteResult =
  | {
      readonly kind: 'written' | 'partial';
      /**
       * Bij `partial`: wat er wél is weggeschreven vóórdat het misging.
       *
       * Uploads gaan één voor één en zijn stuk voor stuk definitief. Faalt document twee,
       * dan stáát document één in de klantmap — een lege fout teruggeven zou dat bestand
       * wees maken: nergens vastgelegd, en bij een nieuwe poging telt het mee als bestaande
       * briefing waar dan een versie naast komt.
       */
      /**
       * In dezelfde volgorde als de aangeboden documenten, en dat is een afspraak waar
       * aanroepers op leunen: zij koppelen er hun eigen gegevens aan — welke trainer, welke
       * rol. Koppelen op naam kan niet, want twee trainers met dezelfde naam op het bord
       * leveren twee identieke gewenste bestandsnamen op.
       */
      readonly written: readonly WrittenBriefing[];
      /** Alleen bij `partial`: waarom de rest niet is gelukt. */
      readonly failure?: { readonly filename: string; readonly reason: string };
    }
  | { readonly kind: 'refused'; readonly reason: string };

export interface WriteOptions {
  /**
   * De adviseur heeft gezien dát er al een briefing ligt en wil er een versie naast.
   *
   * Verplicht zodra er iets botst, en dat is het echte slot: zonder dit vlaggetje is er geen
   * manier om langs een bestaande briefing te komen, ook niet vanuit code die later wordt
   * toegevoegd.
   */
  readonly confirmedExisting?: boolean;
  /**
   * De botsingen die de adviseur daadwerkelijk heeft goedgekeurd.
   *
   * Zonder deze lijst keurt `confirmedExisting` álles goed wat er op het moment van
   * schrijven ligt — en dat is een ander moment. Tussen het bevestigen en het schrijven zit
   * het renderen: sjablonen, Google, de LLM, seconden werk. Twee planners die allebei een
   * lege map zagen bevestigen dan allebei "niets te overschrijven", waarna de eerste het
   * bestand neerzet en de tweede er stilletjes een `(v2)` naast zet die niemand heeft
   * gezien.
   *
   * Ontbreekt de lijst, dan geldt: er is niets bevestigd.
   */
  readonly confirmedConflicts?: readonly string[];
  /**
   * De map die de adviseur te zien kreeg toen hij bevestigde.
   *
   * Het schrijven lost de bestemming opnieuw op, en tussen tonen en schrijven zit het
   * renderen. Hernoemt ITG in die tijd een labelmap, of verschijnt er een jaarmap, dan wijst
   * dezelfde training ineens naar een ándere map — en zou de briefing landen op een plek die
   * niemand heeft goedgekeurd. Ontbreekt deze waarde, dan wordt er niet op gecontroleerd.
   */
  readonly confirmedFolderPath?: string;
}

/**
 * De bestemming is verschoven sinds de adviseur keek.
 *
 * Net als {@link UnreviewedConflict}: niets geschreven, niets stuk. De aanroeper toont het
 * nieuwe plan en laat opnieuw beslissen.
 */
export class UnexpectedDestination extends Error {
  constructor(
    readonly confirmed: string,
    readonly resolved: string
  ) {
    super(`De briefing zou nu in "${resolved}" landen in plaats van in "${confirmed}"`);
    this.name = 'UnexpectedDestination';
  }
}

/**
 * Er is iets bijgekomen sinds de adviseur keek.
 *
 * Geen mislukking: er is niets stuk en niets geschreven. De aanroeper toont het nieuwe plan
 * en laat opnieuw beslissen.
 */
export class UnreviewedConflict extends Error {
  constructor(readonly conflicts: readonly string[]) {
    super(
      `Er ${conflicts.length === 1 ? 'ligt' : 'liggen'} nu ook al ${conflicts.join(', ')}, en dat is niet bevestigd`
    );
    this.name = 'UnreviewedConflict';
  }
}

const kleinLetter = (naam: string): string => naam.toLowerCase();

/** Botsingen die er nú zijn en die niemand heeft goedgekeurd. */
function ongezieneBotsingen(
  gevonden: readonly string[],
  goedgekeurd: readonly string[]
): readonly string[] {
  const bekend = new Set(goedgekeurd.map(kleinLetter));
  return gevonden.filter((naam) => !bekend.has(kleinLetter(naam)));
}

/**
 * Hoe vaak we opnieuw kijken als iemand net die naam heeft ingepikt.
 *
 * Elke ronde levert een hogere versie op, dus dit loopt alleen door zolang er écht andere
 * generaties bezig zijn. Drie is ruim voor twee adviseurs die tegelijk op Genereren drukken,
 * en begrensd genoeg om niet eindeloos te blijven proberen als SharePoint om een andere
 * reden 409 blijft zeggen.
 */
const MAX_NAME_ATTEMPTS = 3;

/**
 * Antwoorden waarbij niet vaststaat of de upload is vastgelegd.
 *
 * Microsoft noemt deze zelf herprobeerbaar voor uploads: ze gaan over de toestand van hún
 * kant, niet over de geldigheid van ons verzoek. Een 4xx is wél een duidelijk antwoord —
 * daar is niets vastgelegd, en dan is er ook niets te herstellen.
 */
const AMBIGU_STATUS = new Set([500, 502, 503, 504]);

/**
 * Eén document wegschrijven, met de naamkeuze en de botsing in één lus.
 *
 * De vrije versienaam komt uit een mappenlijst van een moment eerder. Tussen dat moment en
 * de upload kan een andere generatie diezelfde naam claimen — daarom weigert de upload te
 * overschrijven en kijken we hier opnieuw wat er ligt in plaats van erop te schrijven.
 */
async function schrijfEen(
  store: BriefingStore,
  folderPath: string,
  doc: BriefingDocument,
  bekend: readonly string[],
  goedgekeurd: readonly string[]
): Promise<WrittenBriefing> {
  let bezet = bekend;
  for (let poging = 0; poging < MAX_NAME_ATTEMPTS; poging += 1) {
    const naam = nextVersionName(doc.filename, bezet);
    try {
      const file = await store.upload(folderPath, naam, doc.bytes);
      return { requested: doc.filename, file, versioned: naam !== doc.filename };
    } catch (error) {
      /**
       * Weten we zéker dat hij niet is aangekomen?
       *
       * Alleen bij een duidelijk antwoord van Graph. Een weggevallen verbinding kan vallen
       * ná het moment dat SharePoint de PUT al vastlegde, en een 500/502/503/504 net zo goed:
       * die zegt dat er iets misging op hún kant, niet dát er niets is gebeurd. In beide
       * gevallen doorwerpen zou dat bestand tot wees maken — het staat er, maar het komt niet
       * in `written` en dus niet in Monday, en de volgende poging zet er een versie naast.
       */
      if (!(error instanceof GraphError) || AMBIGU_STATUS.has(error.status)) {
        const gevonden = await store.find(folderPath, naam);
        /**
         * Alleen aannemen dat het de ONZE is als de omvang klopt.
         *
         * Op die naam kan ook het bestand van een gelijktijdige generatie staan. De omvang is
         * geen handtekening, maar twee verschillend samengestelde `.docx`-bestanden komen
         * praktisch nooit op dezelfde byte uit — en bij twijfel is doorwerpen het veilige
         * antwoord: dan meldt hij een mislukking in plaats van andermans bestand te claimen.
         */
        if (gevonden !== null && gevonden.size === doc.bytes.byteLength) {
          return {
            requested: doc.filename,
            file: { id: gevonden.id, name: gevonden.name, webUrl: gevonden.webUrl },
            versioned: naam !== doc.filename,
          };
        }
        throw error;
      }
      if (error.status !== 409) {
        throw error;
      }
      // Iemand was net sneller. Opnieuw kijken wát er nu ligt.
      bezet = await store.files(folderPath);
      /**
       * Ging het net nog om een naam die vrij hoorde te zijn? Dan is dit een botsing die de
       * adviseur nooit gezien heeft, en er hoger overheen versienummeren zou hem een `(v2)`
       * bezorgen waar hij nooit ja tegen zei. Bevestigde botsingen mogen wél doorlopen: daar
       * ís "zet er een versie naast" precies het antwoord dat hij gaf.
       */
      const ongezien = ongezieneBotsingen(
        alreadyExists(doc.filename, bezet) ? [doc.filename] : [],
        goedgekeurd
      );
      if (ongezien.length > 0) {
        throw new UnreviewedConflict(ongezien);
      }
    }
  }
  throw new Error(
    `Kon geen vrije naam vinden voor "${doc.filename}" na ${MAX_NAME_ATTEMPTS} pogingen; ` +
      'er wordt op dit moment kennelijk door meer mensen tegelijk gegenereerd.'
  );
}

export async function writeBriefings(
  store: BriefingStore,
  site: SiteConfig,
  input: PlanInput,
  documents: readonly BriefingDocument[],
  options: WriteOptions = {}
): Promise<WriteResult> {
  const gepland = await planBriefings(store, site, input);
  if (gepland.kind === 'refused') {
    return gepland;
  }
  const { plan } = gepland;

  /**
   * Eerst de bestemming, dan pas de botsingen.
   *
   * Botsingen zijn alleen te beoordelen ten opzichte van een map. Wijst het plan inmiddels
   * naar een andere map, dan zeggen de bevestigde botsingen niets meer — ze gingen over de
   * inhoud van de vorige.
   */
  if (
    options.confirmedFolderPath !== undefined &&
    options.confirmedFolderPath !== plan.folderPath
  ) {
    throw new UnexpectedDestination(options.confirmedFolderPath, plan.folderPath);
  }

  if (plan.conflicts.length > 0 && options.confirmedExisting !== true) {
    throw new UnconfirmedOverwrite(plan.conflicts);
  }

  /**
   * Opnieuw kijken bij de schrijfgrens, niet alleen bij het bevestigen.
   *
   * Tussen die twee momenten zit het renderen, en dat duurt seconden. Wat er in die tijd bij
   * komt is per definitie niet beoordeeld.
   */
  const ongezien = ongezieneBotsingen(plan.conflicts, options.confirmedConflicts ?? []);
  if (ongezien.length > 0) {
    throw new UnreviewedConflict(ongezien);
  }

  if (!plan.folderExists) {
    /**
     * Opsplitsen op de laatste schuine streep is hier exact, niet ongeveer: SharePoint
     * verbiedt `/` in de naam van een item, dus wat erachter staat ís de mapnaam.
     */
    const knip = plan.folderPath.lastIndexOf('/');
    await store.createFolder(plan.folderPath.slice(0, knip), plan.folderPath.slice(knip + 1));
  }

  /**
   * De lijst groeit mee tijdens het schrijven.
   *
   * Anders zouden twee documenten in één run dezelfde vrije naam krijgen — het tweede kijkt
   * dan nog naar de map van vóór het eerste — en overschrijft het tweede het eerste alsnog,
   * binnen dezelfde generatie.
   */
  let bezet = plan.folderExists ? [...(await store.files(plan.folderPath))] : [];
  const written: WrittenBriefing[] = [];

  for (const doc of documents) {
    try {
      written.push(
        await schrijfEen(store, plan.folderPath, doc, bezet, options.confirmedConflicts ?? [])
      );
    } catch (error) {
      /**
       * Niets geschreven? Dan is dit gewoon de fout, en de aanroeper handelt hem af zoals
       * altijd — er staat immers niets in de weg.
       */
      if (written.length === 0) {
        throw error;
      }
      /**
       * Wél al iets geschreven. Die bestanden bestaan en gaan niet meer weg, dus ze moeten
       * gemeld worden: alleen zo komen ze in Monday terecht. Zwijgen zou ze wees maken —
       * nergens vastgelegd, en bij een nieuwe poging tellen ze mee als bestaande briefing.
       */
      return {
        kind: 'partial',
        written,
        failure: {
          filename: doc.filename,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
    bezet = [...bezet, written[written.length - 1].file.name];
  }

  return { kind: 'written', written };
}
