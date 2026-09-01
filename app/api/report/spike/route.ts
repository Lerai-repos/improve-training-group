import { NextResponse } from 'next/server';

import { authorizeBearer } from '@lib/recommend';
import { createPdfRenderer, PAPER } from '@lib/report/pdf';

export const runtime = 'nodejs';

/**
 * Vercel op één punt bewijzen: draait Chromium daar, en komt er een PDF uit?
 *
 * TIJDELIJK. Dit eindpunt bestaat om één vraag te beantwoorden — of de serverless
 * Chromium-bundel het doet op hún platform, met hun geheugen en hun koude start — en gaat
 * eruit zodra het rapport zelf gebouwd wordt.
 *
 * Het rendert een VASTE HTML uit deze bron. Geen invoer, in geen enkele vorm: een route
 * die aangeleverde HTML in een browser laadt is een server-side request forgery met een
 * PDF als uitvoer, en dat is niet iets wat je "even voor een test" openzet.
 *
 * `CONFIG_API_SECRET`, dezelfde sleutel als de configuratie-route: dit is een
 * operatorwerktuig, geen Monday-tab, dus het hoort niet achter een sessietoken.
 */

/** Ruim: Vercel draait dit 4-8x trager dan een ontwikkelmachine. */
export const maxDuration = 60;

const PROBE_HTML = `<!doctype html>
<html lang="nl"><head><meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700&display=swap" rel="stylesheet" />
<style>
  @page { size: ${PAPER.width} ${PAPER.height}; margin: 0; }
  body { margin: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
  .bar { height: 120px; background: #0A2B58; color: #fff; display: flex;
         align-items: center; padding: 0 24px; font-size: 30px; font-weight: 700; }
  .body { padding: 24px; font-size: 12px; }
  .bleed { width: ${PAPER.width}; height: ${PAPER.height};
           background: linear-gradient(135deg, #0A2B58, #6B7C99); page-break-before: always; }
</style></head>
<body>
  <div class="bar">Chromium op Vercel</div>
  <div class="body">
    <p>Deze pagina bestaat om te bewijzen dat de renderer draait: de merkbalk, een
       webfont, en hieronder een full-bleed pagina op ${PAPER.width} bij ${PAPER.height}.</p>
  </div>
  <div class="bleed"></div>
</body></html>`;

export async function GET(request: Request): Promise<NextResponse> {
  if (!authorizeBearer(request.headers.get('authorization'), process.env.CONFIG_API_SECRET)) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  try {
    const pdf = await createPdfRenderer().render(PROBE_HTML);

    return new NextResponse(Buffer.from(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="chromium-probe.pdf"',
        // Het antwoord waar het om gaat, leesbaar zonder de PDF te openen.
        'X-Render-Ms': String(Date.now() - started),
        'X-Pdf-Bytes': String(pdf.length),
      },
    });
  } catch (error) {
    console.error(
      'GET /api/report/spike failed',
      error instanceof Error ? error.stack : String(error)
    );
    return NextResponse.json(
      {
        success: false,
        // Bij een spike hoort de reden wél in het antwoord: hij bestaat om te vertellen
        // wat er misging, en er staat geen klantgegeven in.
        error: error instanceof Error ? error.message : String(error),
        renderMs: Date.now() - started,
      },
      { status: 500 }
    );
  }
}
