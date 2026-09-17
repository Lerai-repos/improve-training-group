/**
 * `--board <id>` van de opdrachtregel, of `null` als de vlag er niet staat.
 *
 * Voor de scripts die kolommen op een agendabord zetten. Zonder deze vlag kozen ze altijd het
 * ingestelde bord (Agenda 2026), dus een melding over Agenda 2027 liet zich met de genoemde
 * opdracht "oplossen" zonder dat 2027 iets kreeg.
 */
export function boardFromArgv(argv: readonly string[]): string | null {
  const at = argv.indexOf('--board');
  if (at < 0) {
    return null;
  }
  const waarde = argv[at + 1];
  if (waarde === undefined || !/^\d+$/.test(waarde)) {
    throw new Error('--board verwacht een bord-id');
  }
  return waarde;
}
