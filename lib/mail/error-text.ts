/**
 * Een fout in één regel, mét zijn oorzaak.
 *
 * `fetch failed` is wat undici zegt als de verbinding wegvalt, en dat is precies niets: het
 * onderscheidt een DNS-fout niet van een gesloten socket, een timeout of een geweigerde
 * upload. De echte reden hangt in `cause`, soms twee lagen diep. Gemeten op een echte
 * mislukte verzending: de regel in het dagoverzicht las alleen "mailen mislukt: fetch failed"
 * en er was daarna niets meer om op terug te kijken.
 *
 * De keten wordt afgekapt, want een oorzaak kan naar zichzelf verwijzen.
 */
const MAX_DIEPTE = 4;

export function describeError(error: unknown): string {
  const delen: string[] = [];
  let huidig: unknown = error;

  for (let i = 0; i < MAX_DIEPTE && huidig !== null && huidig !== undefined; i += 1) {
    const tekst = huidig instanceof Error ? huidig.message : String(huidig);
    const code =
      huidig instanceof Error && 'code' in huidig && typeof huidig.code === 'string'
        ? ` (${huidig.code})`
        : '';
    const regel = `${tekst}${code}`.trim();
    if (regel !== '' && !delen.includes(regel)) {
      delen.push(regel);
    }
    huidig = huidig instanceof Error ? huidig.cause : undefined;
  }

  return delen.length === 0 ? 'onbekende fout' : delen.join(' ← ');
}
