/**
 * Waar de citatenpagina's afbreken.
 *
 * Dit bestand rekent alleen; het meet niets en het raakt geen DOM aan. De hoogtes komen uit
 * Chromium — echte, gerenderde hoogtes, geen schatting op tekenaantal — en de indeling die
 * eruit komt wordt daarna in dezelfde pagina toegepast. Zo is de beslissing te testen zonder
 * browser, en blijft het meten waar het thuishoort.
 *
 * ## Waarom er überhaupt geknipt wordt
 *
 * De citaten liepen als één doorlopend artikel over meerdere pagina's. Dat gaf twee dingen
 * die niet klopten: alleen de eerste en de laatste pagina hadden marge (padding hangt aan het
 * ELEMENT, niet aan de pagina), en het logo hing onderaan datzelfde element — dus halverwege
 * de laatste pagina, en op de tussenliggende pagina's helemaal niet.
 *
 * Een @page-marge lost het eerste op, maar niet het tweede: Chromium zet `position: fixed`
 * op een pagina met eigen marges op de verkeerde plek (gemeten, met twee verschillende
 * offsets, allebei fout). En een achtergrondafbeelding op de wortel herhaalt niet per pagina.
 *
 * Dus doen we het zoals het rapport dat ITG vandaag verstuurt het doet: elke citatenpagina is
 * een ECHTE pagina, met dezelfde opbouw als de andere paginas — eigen padding, eigen logo
 * rechtsonder.
 */

/** Een ondeelbaar stuk: een sectiekop of één citaat. */
export interface Block {
  readonly kind: 'title' | 'item';
  /** De gerenderde hoogte in pixels, inclusief marges. */
  readonly height: number;
}

/**
 * De indeling: per pagina de indexen van de blokken die erop komen.
 *
 * Indexen en geen blokken, zodat de aanroeper zijn eigen elementen kan verplaatsen zonder dat
 * dit bestand iets van HTML hoeft te weten.
 */
export type PagePlan = readonly (readonly number[])[];

/**
 * Een kop mag niet als laatste op een pagina staan.
 *
 * "Waar zie jij nog ruimte voor verbetering?" onderaan een pagina, met de antwoorden op de
 * volgende, leest als een vraag zonder antwoord. Dit is de CSS-regel `page-break-after: avoid`
 * die we hier zelf moeten uitvoeren, omdat wij de pagina's maken en Chromium niet.
 */
function titleWouldStrand(blocks: readonly Block[], index: number, resterend: number): boolean {
  const volgende = blocks[index + 1];
  if (volgende === undefined) {
    return true;
  }
  return volgende.height > resterend;
}

export function planPages(blocks: readonly Block[], available: number): PagePlan {
  const pages: number[][] = [];
  let current: number[] = [];
  let used = 0;

  const nieuwePagina = (): void => {
    if (current.length > 0) {
      pages.push(current);
    }
    current = [];
    used = 0;
  };

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];

    /**
     * Een blok dat op geen enkele pagina past krijgt een pagina voor zich alleen.
     *
     * Anders zou het nergens staan, en een citaat van een deelnemer weggooien omdat het niet
     * past is precies wat de citatensecties nooit mogen doen. De pagina groeit dan mee — de
     * uitvoer gebruikt `min-height`, geen vaste hoogte, juist hiervoor. Alleen op die pagina,
     * zodat de overloop niets anders meesleurt.
     */
    if (block.height > available) {
      nieuwePagina();
      current.push(i);
      nieuwePagina();
      continue;
    }

    if (used + block.height > available) {
      nieuwePagina();
    }

    if (block.kind === 'title' && titleWouldStrand(blocks, i, available - used - block.height)) {
      /**
       * Alleen naar een verse pagina duwen als we er niet al op staan; anders zou een kop
       * met een citaat dat op geen enkele pagina past een oneindige rij lege pagina's geven.
       */
      if (used > 0) {
        nieuwePagina();
      }
    }

    current.push(i);
    used += block.height;
  }

  nieuwePagina();
  return pages;
}
