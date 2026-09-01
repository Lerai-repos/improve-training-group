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

export function createPdfRenderer(): PdfRenderer {
  return {
    async render(html: string): Promise<Uint8Array> {
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

      const browser = await launch({
        args: chromium.args,
        executablePath: await chromium.executablePath(CHROMIUM_BIN),
        headless: true,
      });
      try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load' });
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
        await page.emulateMediaType('print');
        return await page.pdf({
          ...PAPER,
          printBackground: true,
          margin: { ...NO_MARGIN },
        });
      } finally {
        // Always: a leaked browser on a warm serverless instance holds memory until the
        // instance is recycled, and the next invocation launches a second one.
        await browser.close();
      }
    },
  };
}
