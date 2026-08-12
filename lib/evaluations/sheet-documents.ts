/**
 * Which Google Sheets documents hold the evaluation responses.
 *
 * Not secrets, so they live in code rather than in Doppler: they never change, and a
 * wrong id here is caught in review instead of in a dashboard. Destined for the
 * Instellingen board along with the rest of the config, hence the same shape as the
 * per-jaargang Agenda map.
 *
 * The ids are taken from the n8n nodes that read them today (`flow-9`, `flow-4`), so
 * they are the documents ITG is already using, not new ones.
 */

import { z } from 'zod';

import { sourceConfigSchema, type SourceConfig } from './sheets-reader';

/**
 * `Oud 2024` is deliberately absent. Agenda 2024 does not exist in Monday, so its 157
 * evaluated trainings can never attach to anything — reading that document would add a
 * request, a share to negotiate, and no statistics.
 */
export const EVALUATION_DOCUMENTS: SourceConfig = sourceConfigSchema.parse({
  documents: [
    {
      documentId: '1rf2ENu_F6xXFqbdRFE7xi82gXZmC-Q8IwuiVCy85OWw',
      sheetName: 'Formulierreacties 1',
      label: 'nl',
    },
    /**
     * The English form.
     *
     * No n8n flow has ever read it — `04-evaluatierapportage.md:167` lists the English
     * report as new work with "ITG levert de Engelse formulierbron aan" — so these
     * responses have never reached a statistic. Its code column is a two-line question
     * with an embedded newline, which `normalizeHeader` collapses; verified live.
     */
    {
      documentId: '1jQLhaOwEDje_orDd1B-NzdzwwrPFt6Y8lPfFqTTp3ec',
      sheetName: 'Formulierreacties 1',
      label: 'en',
    },
    /**
     * The 2025 archive — 493 responses, and a DIFFERENT form.
     *
     * Measured: 79 trainings from 2025 have evaluations in Airtable that neither current
     * export reproduces (e.g. code `B23`, 6 responses, 2025-02-26), and Agenda 2025 does
     * exist in Monday — so these are recoverable statistics, not a write-off like 2024.
     *
     * Two things about it are not typos on our side:
     *
     * - The tab really is called `aaaa`, and the document is titled "Evaluatieformulieren
     *   (oude situatie, 2025)aaaa". Someone fat-fingered both. We read by id and pin the
     *   tab name; if anyone fixes the typo the nightly run fails loudly and names the
     *   tabs that DO exist, which is a one-line fix here.
     * - Its header row is the older shape: the code column is `IE-code`, and an extra
     *   question ("Voldeed de training aan de verwachtingen…") pushes the eindcijfer to
     *   index 8 instead of 7. Resolved by NAME, which is exactly why `header-map.ts`
     *   refuses to fall back to a column position — index 7 here is a 1-5 sub-score, and
     *   a positional reader would have averaged those instead, silently.
     */
    {
      documentId: '1_cfT_UzOeO1A1xh2UdM923_y8pQuUNyw7AhV65nyppM',
      sheetName: 'aaaa',
      label: 'oud-2025',
    },
  ],
});

/** Read the document list, honouring an env override for a one-off run. */
export function evaluationDocuments(): SourceConfig {
  const raw = process.env.EVAL_SHEETS_DOCUMENTS;
  if (raw === undefined || raw.trim() === '') {
    return EVALUATION_DOCUMENTS;
  }
  const parsed = sourceConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `EVAL_SHEETS_DOCUMENTS is not a valid document list: ${parsed.error.issues[0]?.message ?? 'unknown'}`
    );
  }
  return parsed.data;
}

/** The scope the job needs. Read-only: it never writes to a sheet. */
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

export const oauthCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
});

export type OAuthCredentials = z.infer<typeof oauthCredentialsSchema>;

/**
 * Read the OAuth credentials from the environment, naming what is missing.
 *
 * All three or nothing: a partially configured job would fail at 02:45 with a token
 * error rather than at boot with a sentence.
 */
export function oauthCredentialsFromEnv(
  env: Record<string, string | undefined> = process.env
): OAuthCredentials {
  const parsed = oauthCredentialsSchema.safeParse({
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN,
  });
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(
      `Google Sheets OAuth is not configured — missing or empty: ${missing}. ` +
        `Set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REFRESH_TOKEN ` +
        `(run \`pnpm google:consent\` to mint the refresh token).`
    );
  }
  return parsed.data;
}
