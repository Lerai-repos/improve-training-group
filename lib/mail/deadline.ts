/**
 * Van een looptijdgrens naar een afbreeksignaal.
 *
 * Apart en getest, omdat hier twee dingen misgingen die er allebei uitzien alsof ze werken.
 *
 * **Het is een ABSOLUUT tijdstip, geen resterende duur.** `currentDeadlineMs` geeft een
 * epoch-waarde terug. Die rechtstreeks aan `AbortSignal.timeout` geven levert een limiet van
 * tienduizenden jaren op: een signaal dat bestaat en nooit afgaat. Dat is erger dan geen
 * signaal, want het ziet eruit als dekking.
 *
 * **En hij moet LAAT worden uitgelezen.** De grens leeft in `AsyncLocalStorage` en bestaat
 * pas binnen `runWithDeadline`. Wie hem uitleest terwijl hij de deps opbouwt — vóór de route
 * die context binnengaat — krijgt `null` en geeft dus helemaal niets mee.
 */

/** Wat er nog over is, of `null` als er geen grens is. Nooit negatief. */
export function remainingMs(deadlineMs: number | null, nowMs: number): number | null {
  if (deadlineMs === null) {
    return null;
  }
  return Math.max(deadlineMs - nowMs, 0);
}

/**
 * Het signaal voor één aanroep, of `undefined` buiten elke grens.
 *
 * Per aanroep en niet één keer voor de hele run: elke volgende brok van een upload heeft
 * minder tijd over dan de vorige, en dat hoort hij ook te krijgen.
 */
export function deadlineSignal(
  deadlineMs: () => number | null,
  nowMs: () => number = Date.now
): AbortSignal | undefined {
  const rest = remainingMs(deadlineMs(), nowMs());
  return rest === null ? undefined : AbortSignal.timeout(rest);
}
