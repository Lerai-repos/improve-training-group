import type { LabelAsset } from '@lib/labels/read';

/**
 * De merkafbeeldingen ophalen en als data-URI in het document zetten.
 *
 * **Waarom niet gewoon de URL in de `<img>`?** `public_url` van Monday is één uur geldig. In
 * een document dat wordt gearchiveerd is dat een link die morgen 403 geeft, en tijdens het
 * renderen zou Chromium zelf het netwerk op moeten — een tweede plek waar het stuk kan, in
 * een proces dat verder volledig offline is. Wij halen het bestand hier op, seconden voor het
 * renderen, en zetten de inhoud in de pagina.
 */

/** Ruim boven het grootste echte bestand (FT's voorblad, 18 MB) en ver onder een geheugenprobleem. */
const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export interface InlinedAsset {
  readonly dataUri: string;
  readonly bytes: number;
  readonly contentType: string;
}

export type AssetResult = { kind: 'ok'; asset: InlinedAsset } | { kind: 'failed'; reason: string };

/**
 * Eén afbeelding ophalen.
 *
 * Geeft een MISLUKKING terug in plaats van te werpen. Een ontbrekend logo mag geen rapport
 * tegenhouden — het document is zonder logo nog steeds bruikbaar — maar het moet wél
 * zichtbaar zijn dat het miste, en dat is aan de aanroeper.
 */
export async function inlineAsset(asset: LabelAsset): Promise<AssetResult> {
  try {
    const response = await fetch(asset.publicUrl, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return { kind: 'failed', reason: `${asset.name}: HTTP ${response.status}` };
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!ALLOWED.has(contentType)) {
      // Een HTML-foutpagina met status 200 is precies hoe een verlopen URL zich gedraagt;
      // die als afbeelding inbedden geeft een leeg vlak zonder enige melding.
      return { kind: 'failed', reason: `${asset.name}: onverwacht type "${contentType}"` };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) {
      return {
        kind: 'failed',
        reason: `${asset.name}: ${Math.round(buffer.byteLength / 1024 / 1024)} MB is te groot`,
      };
    }

    return {
      kind: 'ok',
      asset: {
        dataUri: `data:${contentType};base64,${buffer.toString('base64')}`,
        bytes: buffer.byteLength,
        contentType,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'failed', reason: `${asset.name}: ${message}` };
  }
}

export interface LabelArtwork {
  readonly logo: InlinedAsset | null;
  readonly voorblad: InlinedAsset | null;
  readonly achterblad: InlinedAsset | null;
  /** Wat er niet gelukt is, in mensentaal. Leeg als alles goed ging. */
  readonly problems: readonly string[];
}

/**
 * De drie afbeeldingen van één label, parallel opgehaald.
 *
 * Parallel omdat ze onafhankelijk zijn en de tijdslimiet van de renderroute krap is; een
 * voorblad van 18 MB serieel achter de andere twee is zonde van de seconden.
 */
export async function fetchArtwork(label: {
  logo: LabelAsset | null;
  voorblad: LabelAsset | null;
  achterblad: LabelAsset | null;
}): Promise<LabelArtwork> {
  const wanted = [
    ['logo', label.logo],
    ['voorblad', label.voorblad],
    ['achterblad', label.achterblad],
  ] as const;

  const results = await Promise.all(
    wanted.map(async ([key, asset]) =>
      asset === null ? ([key, null] as const) : ([key, await inlineAsset(asset)] as const)
    )
  );

  const out: Record<string, InlinedAsset | null> = {};
  const problems: string[] = [];
  for (const [key, result] of results) {
    if (result === null) {
      out[key] = null;
      continue;
    }
    if (result.kind === 'failed') {
      out[key] = null;
      problems.push(result.reason);
      continue;
    }
    out[key] = result.asset;
  }

  return {
    logo: out.logo ?? null,
    voorblad: out.voorblad ?? null,
    achterblad: out.achterblad ?? null,
    problems,
  };
}
