/**
 * HTML → PDF, on the same engine ITG's reports are rendered on today.
 *
 * pdf.co is Chromium-as-a-service, and the report's layout leans on that: the paper is
 * deliberately a fraction under A4 and the full-bleed images overscan by 2px, both to
 * work around Chromium's own rounding. Rendering on anything else would reopen the white
 * edges those tricks exist to close, so "our own rendering" means our own Chromium.
 *
 * One code path for local and serverless. `@sparticuz/chromium` inflates its packed
 * binary to `/tmp` and works on any Linux x64, so a developer's machine and a Vercel
 * function run the same browser — which is the only way a fidelity check here means
 * anything about production.
 */

import { join } from 'node:path';

import chromium from '@sparticuz/chromium';
import { launch } from 'puppeteer-core';

import type { Page } from 'puppeteer-core';

import { planPages } from './paginate';

import type { Block } from './paginate';

/**
 * 209,5 × 296 mm — a hair under A4, and not a typo.
 *
 * Combined with the 2px overscan on the full-bleed images it stops Chromium's rounding
 * from leaving a white hairline down the edge of a cover page. Legacy pins the same
 * figure; changing it brings the hairlines back.
 */
export const PAPER = { width: '209.5mm', height: '296mm' } as const;

/**
 * Waar de brotli-pakketjes van Chromium staan.
 *
 * NIET in `node_modules`. pnpm zet `@sparticuz/chromium` daar neer als symlink naar de
 * store, en Next's tracing daardoorheen levert een bundel op die wél bouwt maar die
 * Vercel weigert uit te rollen: *"files in symlinked directories"*. `scripts/copy-chromium.mjs`
 * zet er vóór elke build echte kopieën neer op dit pad.
 *
 * `process.cwd()` en niet `__dirname`, om dezelfde reden als bij de briefingsjablonen:
 * in de serverless-bundel wijst `__dirname` naar de gebundelde module, niet naar de
 * wortel van de functie.
 */
const CHROMIUM_BIN = join(process.cwd(), '.chromium-bin');

/** No margins: the template owns its own padding, and the covers must reach the edge. */
export const NO_MARGIN = { top: '0', right: '0', bottom: '0', left: '0' } as const;

export interface PdfRenderer {
  render(html: string): Promise<Uint8Array>;
}

/**
 * Een bovengrens per rapport, ook zonder looptijdgrens van een route.
 *
 * Gemeten duurt een render 2,8 seconden; twee minuten is veertig keer zoveel. Wie hier
 * tegenaan loopt heeft geen traag rapport maar een vastgelopen Chromium, en dan is stoppen
 * beter dan blijven hangen — een script dat 's nachts blijft staan merkt ook niemand.
 */
export const MAX_RENDER_MS = 120_000;

/**
 * Hoeveel tijd deze render mag kosten.
 *
 * **`runWithDeadline` breekt uit zichzelf niets af.** Het bewaart alleen een tijdstip in
 * `AsyncLocalStorage`; elke cliënt moet er zelf naar kijken. De Graph-client doet dat via een
 * `AbortSignal`, en Chromium deed dat tot nu toe helemaal niet. Eén vastgelopen render kon
 * daardoor over Vercels 300 seconden heen lopen, waarna het platform de functie beëindigt —
 * en dán is er geen `catch` meer, dus geen melding, geen teruggegeven claim, en de trainingen
 * die nog in de rij stonden zijn niet verwerkt.
 */
export function renderBudget(
  deadlineMs?: () => number | null,
  nowMs: () => number = Date.now
): number {
  const deadline = deadlineMs?.() ?? null;
  if (deadline === null) {
    return MAX_RENDER_MS;
  }
  return Math.max(Math.min(deadline - nowMs(), MAX_RENDER_MS), 0);
}

/**
 * Werpt zodra het budget op is.
 *
 * **De aanroeper moet hem METEEN in een race zetten.** Een `Promise` die verwerpt zonder dat
 * er een afhandelaar aan hangt is in Node een `unhandledRejection`, en die neemt het hele
 * proces mee — een middel dat erger is dan de kwaal waar hij voor bedoeld is. Daarom staat de
 * race hieronder om álles heen en niet om een tussenstap.
 */
function afterBudget(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Het renderen van het rapport duurde langer dan ${ms} ms.`));
    }, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * De citatenpagina's opknippen: meten in de browser, beslissen in Node, toepassen in de
 * browser.
 *
 * Meten hóórt in de browser — het zijn echte, gerenderde hoogtes, geen schatting op
 * tekenaantal, en een schatting die er net naast zit kapt een citaat af. Beslissen hoort
 * juist buiten de browser: dan is de indeling te testen zonder Chromium, en dat is waar
 * `lib/report/paginate.ts` voor bestaat.
 *
 * Doet niets als er geen citatenpagina in het document zit. Dat is geen randgeval maar de
 * normale toestand van elk ander document dat ooit door deze renderer gaat.
 */
async function paginateFeedback(page: Page): Promise<void> {
  const metrics = await page.evaluate((): { blocks: Block[]; available: number } | null => {
    const source = document.querySelector('[data-feedback-source]');
    if (source === null) {
      return null;
    }
    const main = source.querySelector('main');
    if (main === null) {
      return null;
    }
    /**
     * De beschikbare hoogte wordt UITGEREKEND, niet gemeten.
     *
     * Het bronartikel is met opzet meegegroeid met al zijn inhoud — anders viel er niets te
     * meten — dus `main.clientHeight` is daar de hoogte van álle citaten samen, niet die van
     * één pagina. Dat was precies de fout: er kwam 1757px uit waar 1119px hoorde, en dan
     * "past" alles altijd.
     *
     * De `min-height` van het artikel ís een pagina, en de padding van `main` is wat de
     * sjabloon eromheen zet. Die twee samen geven de ruimte waar de blokken in moeten,
     * onafhankelijk van hoeveel inhoud er toevallig staat.
     */
    const pageHeight = parseFloat(window.getComputedStyle(source).minHeight);
    const mainStyle = window.getComputedStyle(main);
    const available =
      pageHeight - parseFloat(mainStyle.paddingTop) - parseFloat(mainStyle.paddingBottom);
    const blocks = [...main.querySelectorAll<HTMLElement>('[data-block]')].map((el): Block => {
      const style = window.getComputedStyle(el);
      const marges = parseFloat(style.marginTop) + parseFloat(style.marginBottom);
      return {
        kind: el.dataset.block === 'title' ? 'title' : 'item',
        height: el.getBoundingClientRect().height + marges,
      };
    });
    return { blocks, available };
  });

  if (metrics === null || metrics.blocks.length === 0 || metrics.available <= 0) {
    return;
  }

  const plan = planPages(metrics.blocks, metrics.available);

  await page.evaluate((pages: readonly (readonly number[])[]): void => {
    const source = document.querySelector('[data-feedback-source]');
    if (source === null) {
      return;
    }
    const main = source.querySelector('main');
    if (main === null) {
      return;
    }
    const blocks = [...main.querySelectorAll<HTMLElement>('[data-block]')];

    for (const indexen of pages) {
      /**
       * Elke pagina is een KLOON van het origineel, inclusief het logo.
       *
       * Zo hoeft deze code niets te weten van de opmaak: wat de sjabloon aan een
       * citatenpagina meegeeft, krijgt elke pagina.
       */
      const article = source.cloneNode(false);
      if (!(article instanceof HTMLElement)) {
        return;
      }
      article.removeAttribute('data-feedback-source');
      const doel = document.createElement('main');
      doel.className = main.className;
      article.append(doel);

      let lijst: HTMLElement | null = null;
      for (const index of indexen) {
        const block = blocks[index];
        if (block.dataset.block === 'title') {
          doel.append(block);
          lijst = null;
          continue;
        }
        if (lijst === null) {
          lijst = document.createElement('ul');
          doel.append(lijst);
        }
        lijst.append(block);
      }

      for (const extra of source.children) {
        if (extra.tagName !== 'MAIN') {
          article.append(extra.cloneNode(true));
        }
      }
      source.parentNode?.insertBefore(article, source);
    }

    source.remove();
  }, plan);
}

type Browser = Awaited<ReturnType<typeof launch>>;

/** Ruim genoeg voor een nette afsluiting, kort genoeg om de volgende training niet op te eten. */
export const CLOSE_BUDGET_MS = 5_000;

/**
 * Wat er over de browser bekend is, gedeeld tussen het werk en de opruiming.
 *
 * `afgebroken` is het antwoord op het gat dat `Promise.race` laat: die stopt de verliezer
 * niet. Verstrijkt het budget terwijl `launch` nog bezig is, dan ziet de opruiming nog geen
 * browser, keert terug — en start Chromium daarna alsnog op, om vrolijk verder te renderen
 * terwijl de dagjob al aan de volgende training begonnen is. Op een koude instantie, waar het
 * uitpakken van de binary seconden kost, is dat geen theoretisch geval.
 */
interface BrowserHouder {
  browser: Browser | null;
  afgebroken: boolean;
}

/**
 * Sluiten met een eigen grens, en desnoods hardhandig.
 *
 * `close()` kan zelf blijven hangen op een browser die niet meer antwoordt, en dan is de
 * opruiming precies zo erg als het probleem. De klok RESOLVET hier (hij werpt niet), want een
 * verwerping die niemand opvangt is hoe deze hele grens ooit begon mis te gaan.
 */
export interface Sluitbaar {
  close(): Promise<void>;
  readonly connected: boolean;
  /** Alleen het signaal dat we echt sturen; breder maakt hem niet compatibel met Node's type. */
  process(): { kill(signal: 'SIGKILL'): unknown } | null;
}

/**
 * Werpt zodra de opruiming langs is geweest.
 *
 * Eén definitie voor twee momenten, want er zijn twee vensters waarin de grens kan
 * verstrijken zonder dat de opruiming iets aantreft om te sluiten: terwijl de Chromium-binary
 * wordt uitgepakt, en terwijl de browser opstart. Na het opstarten is de browser bekend en
 * ruimt de `finally` hem gewoon op; dáárvoor is deze controle het enige wat het werk stopt.
 */
function stopAlsAfgebroken(houder: { readonly afgebroken: boolean }): void {
  if (houder.afgebroken) {
    throw new Error('Het renderen is afgebroken: de looptijdgrens was al verstreken.');
  }
}

export async function sluitAf(
  browser: Sluitbaar,
  budgetMs: number = CLOSE_BUDGET_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const klok = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  try {
    await Promise.race([browser.close().catch(() => undefined), klok]);
  } finally {
    clearTimeout(timer);
  }
  if (browser.connected) {
    browser.process()?.kill('SIGKILL');
  }
}

export function createPdfRenderer(deadlineMs?: () => number | null): PdfRenderer {
  return {
    async render(html: string): Promise<Uint8Array> {
      const budget = renderBudget(deadlineMs);
      /**
       * Geen tijd meer? Dan meteen stoppen, en niet aan een browser beginnen.
       *
       * Puppeteer leest `timeout: 0` als "geen tijdslimiet", dus een leeg budget zou élke
       * grens uitzetten in plaats van aanzetten — precies het tegenovergestelde. En een render
       * starten die er toch niet meer doorheen komt kost alleen de tijd die de trainingen
       * hierna nog nodig hebben.
       */
      if (budget <= 0) {
        throw new Error('Geen tijd meer binnen de looptijdgrens om een rapport te renderen.');
      }

      const grens = afterBudget(budget);
      /**
       * De browser staat BUITEN het werk, zodat de `finally` hem ook kan sluiten wanneer de
       * grens wint. Anders blijft er een Chromium draaien op een warme serverless-instantie
       * en start de volgende aanroep er een tweede naast.
       */
      const geopend: BrowserHouder = { browser: null, afgebroken: false };

      const werk = async (): Promise<Uint8Array> => {
        /**
         * WebGL off — for the flags, NOT for the cold start.
         *
         * The package's own type doc claims `swiftshader.tar.br` is skipped when this is
         * false. It is not: `executablePath()` inflates it unconditionally. Measured on
         * 1-Sep-2026 — the shader libraries land in `/tmp` either way, and extraction took
         * 1243 ms with graphics off against 1013 ms with it on, which is noise.
         *
         * What it does do is swap `--use-gl=angle --use-angle=swiftshader
         * --enable-unsafe-swiftshader` for `--disable-webgl`, so the software GL stack is
         * never initialised at launch. The report's only "graphic" is a CSS
         * conic-gradient pie, so nothing here wants WebGL. Kept for that reason alone; if
         * the extraction cost ever needs to come down, that is the `-min` package and a
         * hosted pack file, not this flag.
         */
        chromium.setGraphicsMode = false;

        /**
         * Het uitpakken APART, en daarna pas kijken of we nog mogen.
         *
         * Stond dit als `await` binnen het argument van `launch`, dan viel het uitpakken —
         * gemeten 1243 ms, en juist de kosten van een koude start — buiten elke controle: de
         * opruiming zette de vlag, zag nog geen browser, keerde terug, en dit startte daarna
         * alsnog een Chromium op.
         */
        const executablePath = await chromium.executablePath(CHROMIUM_BIN);
        stopAlsAfgebroken(geopend);

        const browser = await launch({
          args: chromium.args,
          executablePath,
          headless: true,
          timeout: budget,
        });
        geopend.browser = browser;
        /**
         * En nog een keer, want opstarten kost ook tijd.
         *
         * Hierna is de browser bekend en sluit de `finally` hem uit zichzelf; dit is het
         * laatste venster waarin het werk zichzelf moet opruimen.
         */
        if (geopend.afgebroken) {
          await sluitAf(browser);
          stopAlsAfgebroken(geopend);
        }

        const page = await browser.newPage();
        page.setDefaultTimeout(budget);
        await page.setContent(html, { waitUntil: 'load', timeout: budget });
        /**
         * Wait for the FONTS, not for the network to go quiet.
         *
         * The template pulls Plus Jakarta Sans from Google Fonts, and printing before it
         * lands silently falls back to a system face on a document that goes to a
         * client. `document.fonts.ready` waits for exactly that rather than for a proxy,
         * and it resolves immediately once the face is inlined — which is what should
         * happen before this goes live.
         */
        await page.evaluate(() => document.fonts.ready);
        /**
         * Ná de fonts, vóór het printen.
         *
         * De hoogtes moeten gemeten worden met het échte lettertype. Meten met de
         * terugvalletter geeft andere regelafbrekingen, en dus een indeling die net niet
         * klopt op het document dat de klant krijgt.
         */
        await paginateFeedback(page);
        await page.emulateMediaType('print');
        return await page.pdf({
          ...PAPER,
          printBackground: true,
          margin: { ...NO_MARGIN },
          timeout: budget,
        });
      };

      try {
        /**
         * Eén race, om ALLES.
         *
         * Puppeteer's eigen tijdslimieten dekken het laden en het printen, maar niet het
         * uitpakken van de Chromium-binary, het starten zelf, het meten daartussen, of een
         * browser die halverwege niet meer antwoordt. En de race moet hier staan en niet om
         * een tussenstap: dan hangt er vanaf het eerste moment een afhandelaar aan de
         * grens-promise, en kan die nooit als `unhandledRejection` het proces meenemen.
         */
        return await Promise.race([werk(), grens.promise]);
      } finally {
        grens.cancel();
        /**
         * Eerst de vlag, dan sluiten.
         *
         * De vlag vóór het sluiten zetten dekt precies het geval dat `launch` nog loopt: die
         * ziet hem straks staan en ruimt zichzelf op. Sluiten dekt het geval dat de browser er
         * al is. Samen overleeft er geen werk de grens.
         */
        geopend.afgebroken = true;
        const browser = geopend.browser;
        if (browser !== null) {
          await sluitAf(browser);
        }
      }
    },
  };
}
