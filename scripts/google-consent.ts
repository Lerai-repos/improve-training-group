/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import { consentUrl, exchangeCode } from '@lib/evaluations/google-sheets-source';

/**
 * Mint the Google refresh token, once, by hand.
 *
 * Runs a throwaway localhost server, opens Google's consent screen, catches the
 * redirect, swaps the code for a refresh token and prints it. Exists so nobody has to
 * hand-assemble an authorization URL and paste a code out of a browser address bar —
 * the step where `access_type=offline` gets forgotten and Google silently returns no
 * refresh token at all.
 *
 * The OAuth client must be of type **Desktop app**, which is what makes an arbitrary
 * `http://localhost:<port>` redirect acceptable without registering it.
 *
 *   doppler run -c prd -- pnpm google:consent
 *
 * Sign in as the account that can see the sheets (`automation@lerai.nl`). The printed
 * token goes into Doppler as GOOGLE_OAUTH_REFRESH_TOKEN.
 */

const CALLBACK_PATH = '/oauth/callback';
/** Long enough to sign in and pick an account, short enough not to hang a terminal. */
const TIMEOUT_MS = 5 * 60 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing ${name}. Both the client id and secret must be present — ` +
        `try \`doppler run -c prd -- pnpm google:consent\`.`
    );
  }
  return value;
}

/** Serve one request, hand back the `code` it carried. */
function awaitCode(port: { value: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://localhost:${port.value}`);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end('not here');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        code === null
          ? `<h1>Geen toegang verleend</h1><p>${error ?? 'onbekende fout'}</p>`
          : '<h1>Gelukt</h1><p>Je kunt dit tabblad sluiten en terug naar de terminal.</p>'
      );
      server.close();

      if (code === null) {
        reject(new Error(`Consent was refused: ${error ?? 'unknown error'}`));
        return;
      }
      resolve(code);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine the callback port'));
        return;
      }
      port.value = (address as AddressInfo).port;
    });

    setTimeout(() => {
      server.close();
      reject(new Error(`No response within ${TIMEOUT_MS / 1000}s — nothing was changed.`));
    }, TIMEOUT_MS).unref();
  });
}

async function main(): Promise<void> {
  const clientId = requireEnv('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = requireEnv('GOOGLE_OAUTH_CLIENT_SECRET');

  const port = { value: 0 };
  const codePromise = awaitCode(port);
  // Give `listen` a tick to assign the port before the URL is built.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const redirectUri = `http://localhost:${port.value}${CALLBACK_PATH}`;
  const url = consentUrl(clientId, redirectUri);

  console.log('\nOpen deze URL, log in als het account dat de sheets kan zien:\n');
  console.log(`  ${url}\n`);
  console.log('Wachten op de redirect…\n');

  const code = await codePromise;
  const { refreshToken } = await exchangeCode({ clientId, clientSecret, code, redirectUri });

  console.log('Gelukt. Zet deze waarde in Doppler (config prd):\n');
  console.log(`  GOOGLE_OAUTH_REFRESH_TOKEN=${refreshToken}\n`);
  console.log('Daarna: doppler run -c prd -- pnpm eval:probe\n');
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
