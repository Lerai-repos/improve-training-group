import { PAPER } from './pdf';
import { escapeHtml } from './text';

import type { LabelArtwork } from './assets';
import type { ChartColours } from './colours';
import type { ChartModel, ReportModel } from './types';

/**
 * De HTML van het evaluatierapport.
 *
 * Herbouw van `build-html-code.js` — 497 regels string-plakwerk, want de n8n-sandbox stond
 * geen template literals toe. De opmaak is met opzet ongewijzigd overgenomen: ITG verstuurt
 * deze rapporten al maanden en dit vervangt alleen de motor eronder.
 *
 * **Twee dingen zijn wél anders, allebei omdat ze in een PDF-render niet deugen:**
 *
 * 1. De balkhoogtes en de taartpunten worden HIER uitgerekend en als `style` meegegeven. De
 *    oude versie zette ze met een script ná het laden, mét een CSS-overgang van 0,35 s — in
 *    een browser onzichtbaar, maar bij het vastleggen van een PDF is dat een wedloop die je
 *    soms verliest, en dan staan de balken half omhoog in een document dat naar een klant gaat.
 * 2. Het papier is 209,5 × 296 mm in plaats van A4, met 2 px overscan op de paginavullende
 *    afbeeldingen. Dat is de bestaande reparatie tegen witte randjes door afrondingsverschillen
 *    in Chromium, en die hoort mee te verhuizen.
 */

/** Overscan tegen witte randjes door subpixel-afronding. */
const BLEED = '2px';

const esc = escapeHtml;

function chartHtml(chart: ChartModel, gradeScale: boolean): string {
  const barClass = gradeScale ? 'bar-container bar-container--grade' : 'bar-container';
  const labelClass = gradeScale ? 'bar-labels bar-labels--grade' : 'bar-labels';
  const barsHtml = chart.bars
    .map(
      (bar) =>
        `<div class="bar"><div class="fill" style="height:${bar.pct}%">` +
        `<span class="value-label">${esc(bar.label)}</span></div></div>`
    )
    .join('');
  const axisHtml = chart.axis.map((tick) => `<span>${esc(tick)}</span>`).join('');

  return (
    `<div class="chart">` +
    `<h4>${esc(chart.question)}</h4>` +
    `<p>${esc(chart.subtitle)}</p>` +
    `<div class="${barClass}">${barsHtml}</div>` +
    `<div class="${labelClass}">${axisHtml}</div>` +
    `</div>`
  );
}

/** Een paginavullende afbeelding, of niets als het label er geen heeft. */
function bleedPage(dataUri: string | null): string {
  if (dataUri === null) {
    return '';
  }
  return (
    `<article class="page document-section bleed">` + `<img src="${dataUri}" alt="" /></article>`
  );
}

function quoteList(items: readonly string[]): string {
  if (items.length === 0) {
    return '<li>Geen feedback ontvangen.</li>';
  }
  return items.map((quote) => `<li>&ldquo;${esc(quote)}&rdquo;</li>`).join('');
}

function logoHtml(artwork: LabelArtwork, labelNaam: string, className: string): string {
  if (artwork.logo === null) {
    return '';
  }
  return `<img src="${artwork.logo.dataUri}" class="${className}" alt="${esc(labelNaam)}" />`;
}

export function renderReportHtml(
  model: ReportModel,
  artwork: LabelArtwork,
  colours: ChartColours
): string {
  const logo = logoHtml(artwork, model.labelNaam, 'page-logo');
  const term = esc(model.rapportterm);
  const trainer = esc(model.trainerNamen);

  const intro =
    `Recentelijk heeft onze ${esc(model.trainerWoord)} <strong>${trainer}</strong> voor ` +
    `jullie met veel plezier ${term} <strong>${esc(model.klanttitel)}</strong> gefaciliteerd. ` +
    `Aan het einde van ${term} hebben deelnemers de mogelijkheid gehad om de trainer en ` +
    `${term} te evalueren. De resultaten daarvan delen we graag met je.`;

  const aanhef = model.contactNamen === '' ? 'Beste,' : `Beste ${esc(model.contactNamen)},`;

  const legend = model.followUp.slices
    .map(
      (slice) =>
        `<li><span class="swatch" style="background:${slice.colour}"></span> ` +
        `${esc(slice.label)}: ${slice.value}</li>`
    )
    .join('');

  const pie =
    model.followUp.gradient === ''
      ? '<div class="pie pie--empty" role="img" aria-label="Geen antwoorden"></div>'
      : `<div class="pie" role="img" aria-label="Verdeling" ` +
        `style="background:${model.followUp.gradient}"></div>`;

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
<title>Evaluatierapport</title>
<style>
  :root{
    --brand:${colours.brand};
    --brand-mid:${colours.mid};
    --cream:#FAF5EF;
  }
  @page{size:${PAPER.width} ${PAPER.height};margin:0;}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  body{color:#000;font-family:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;}
  .page{width:${PAPER.width};height:${PAPER.height};position:relative;display:flex;flex-direction:column;overflow:hidden;}
  .document-section{page-break-before:always;}
  .document-section:first-child{page-break-before:auto;}
  .bleed{padding:0;}
  /* Overscan: de afbeelding steekt 2px buiten de pagina, anders laat afronding een witte lijn staan. */
  .bleed img{width:calc(${PAPER.width} + ${BLEED});height:calc(${PAPER.height} + ${BLEED});object-fit:cover;margin:-1px;display:block;}
  .page-with-header{background:linear-gradient(to bottom,var(--brand) 120px,#fff 120px);}
  .header-title{margin:0;height:120px;display:flex;align-items:center;padding:0 16mm;font-weight:700;font-size:34px;letter-spacing:.2px;color:#fff;}
  main{padding:8mm 16mm 20mm;flex:1;}
  .intro h2{margin:0 0 16px;font-size:23px;font-weight:700}
  .intro p{margin:0 0 10px;font-size:14px}
  .section-title{margin:28px 0 12px;font-weight:700;font-size:18px}
  .kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin:16px 0 8px;max-width:720px}
  .kpi{background:var(--cream);border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:14px;}
  .kpi .icon{flex-shrink:0;width:36px;height:36px;display:grid;place-items:center}
  .kpi .label{font-weight:600;font-size:14px;color:var(--brand);line-height:1.3}
  .kpi .divider{flex:0 0 1px;height:28px;background:#ccc;margin:0 10px}
  .kpi .number{font-weight:700;font-size:20px;color:var(--brand);flex:1;display:flex;align-items:center;justify-content:center}
  .chart-section{margin-top:36px;}
  .chart{margin:28px 0;}
  .chart h4{margin:0 0 2px;font-size:14px;font-weight:700}
  .chart p{margin:0 0 8px;font-size:14px;font-weight:400}
  .bar-container{display:flex;align-items:flex-end;gap:18px;height:120px;margin-top:12px;padding:8px 6px 6px;border-left:1px solid #999;border-bottom:1px solid #999;position:relative;}
  .bar{flex:1 1 0;height:100%;display:flex;align-items:flex-end;justify-content:center;position:relative;}
  /* Bewust geen overgangsanimatie: de hoogte staat al goed vóór het renderen, en een animatie zou het vastleggen kunnen betrappen terwijl de balk nog groeit. */
  .bar .fill{width:60%;background:var(--brand-mid);border-radius:2px 2px 0 0;position:relative;}
  .bar .value-label{position:absolute;top:-18px;left:50%;transform:translateX(-50%);font-size:13px;white-space:nowrap;}
  .bar-labels{display:grid;grid-template-columns:repeat(5,1fr);margin-top:6px;font-size:13px}
  .bar-labels span{text-align:center}
  .chart .bar-container,.chart .bar-labels{max-width:520px;margin-left:auto;margin-right:auto}
  .bar-container--grade{gap:9px;}
  .bar-container--grade .value-label{font-size:11px;}
  .bar-labels--grade{grid-template-columns:repeat(10,1fr);}
  .chart .bar-container--grade,.chart .bar-labels--grade{max-width:600px;}
  .pie-chart-section{margin-top:36px;}
  .pie-container{display:flex;align-items:center;gap:24px;margin-top:24px}
  .pie{width:220px;height:220px;border-radius:50%;flex:0 0 220px;}
  .pie--empty{background:#dde5f3;}
  .pie-legend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
  .pie-legend li{display:flex;align-items:center;gap:8px;font-size:14px}
  .swatch{width:14px;height:14px;border-radius:3px;display:inline-block}
  .page-logo{position:absolute;bottom:12px;right:20px;height:64px;width:auto;}
  /* De citaten mogen NIET afkappen: geen vaste hoogte, geen overflow. Dat was een expliciete reparatie. */
  .feedback-page{page-break-before:always;position:relative;padding:16mm;}
  .quotes ul{margin:6px 0 0;padding-left:22px;}
  .quotes li{margin:6px 0;font-size:14px;page-break-inside:avoid;}
  .quotes li::marker{color:var(--brand)}
  .quotes .section-title{page-break-after:avoid;}
  /* ABSOLUTE, niet fixed. Een fixed element herhaalt Chromium op ELKE pagina van het
     document - dus ook boven op het voor- en achterblad. Absolute zet hem onderaan de
     citatensectie, precies zoals de bestaande rapporten het doen. */
  .feedback-logo{position:absolute;bottom:12px;right:20px;height:64px;width:auto;}
</style>
</head>
<body>
${bleedPage(artwork.voorblad?.dataUri ?? null)}
<article class="page document-section page-with-header">
  <h1 class="header-title">Evaluatierapport</h1>
  <main>
    <section class="intro">
      <h2>${aanhef}</h2>
      <p>${intro}</p>
      <p>Heb je vragen over de resultaten? Laat het ons weten, dan helpen we je graag!</p>
    </section>
    <section class="highlights">
      <h3 class="section-title">Belangrijkste resultaten</h3>
      <div class="kpis">
        <div class="kpi">
          <div class="icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="3" width="16" height="18" rx="2" stroke="${colours.brand}"/><path d="M8 7H16M8 11H16M8 15H13" stroke="${colours.brand}" stroke-linecap="round"/></svg></div>
          <div class="label">Gemiddelde<br>beoordeling</div>
          <div class="divider"></div>
          <div class="number">${esc(model.gemiddeldeBeoordeling ?? '—')}</div>
        </div>
        <div class="kpi">
          <div class="icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="3" stroke="${colours.brand}"/><circle cx="16" cy="9" r="2.5" stroke="${colours.brand}"/><path d="M3.5 19c0-2.5 2-4.5 4.5-4.5S12.5 16.5 12.5 19" stroke="${colours.brand}"/><path d="M13.5 19c0-1.9 1.5-3.4 3.4-3.4 1.9 0 3.6 1.5 3.6 3.4" stroke="${colours.brand}"/></svg></div>
          <div class="label">Aantal<br>respondenten</div>
          <div class="divider"></div>
          <div class="number">${model.aantalRespondenten}</div>
        </div>
      </div>
      ${chartHtml(model.cijferChart, true)}
    </section>
  </main>
  ${logo}
</article>
<article class="page document-section">
  <main>
    <section class="chart-section">
      <h3 class="section-title">Over ${term}</h3>
      ${model.trainingCharts.map((c) => chartHtml(c, false)).join('')}
    </section>
  </main>
  ${logo}
</article>
<article class="page document-section">
  <main>
    <section class="chart-section">
      <h3 class="section-title">Over de ${esc(model.trainerWoord)}</h3>
      ${model.trainerCharts.map((c) => chartHtml(c, false)).join('')}
    </section>
    <section class="pie-chart-section">
      <h3 class="section-title">Over een eventuele follow-up</h3>
      <div class="chart">
        <h4>Lijkt het je waardevol om in een opvolgsessie te verdiepen?</h4>
        <p>${esc(model.followUp.subtitle)}</p>
        <div class="pie-container">${pie}<ul class="pie-legend">${legend}</ul></div>
      </div>
    </section>
  </main>
  ${logo}
</article>
<article class="feedback-page">
  <section class="quotes">
    <h3 class="section-title">Op welk(e) aspect(en) van de sessie kijk je positief terug en waarom?</h3>
    <ul>${quoteList(model.positieveCitaten)}</ul>
  </section>
  <section class="quotes">
    <h3 class="section-title">Waar zie jij nog ruimte voor verbetering of aanpassing van deze training?</h3>
    <ul>${quoteList(model.verbeterCitaten)}</ul>
  </section>
  ${logoHtml(artwork, model.labelNaam, 'feedback-logo')}
</article>
${bleedPage(artwork.achterblad?.dataUri ?? null)}
</body>
</html>`;
}
