/**
 * De cijfers achter de grafieken: verdelingen, percentages en de follow-up-telling.
 *
 * Alles hier is puur en werkt op de ruwe antwoorden. Dat is een verschil met de bestaande
 * generator, die de verdelingen kant-en-klaar uit een n8n-stap kreeg — en het is nodig, want
 * die stap verhuist niet mee.
 */

const GRADE_MIN = 1;
const GRADE_MAX = 10;
const SCORE_MIN = 1;
const SCORE_MAX = 5;
const PERCENT = 100;

export interface Bar {
  /** Hoeveel respondenten deze waarde kozen. */
  readonly count: number;
  /** Afgerond percentage van het totaal. */
  readonly pct: number;
  /** Wat er boven de balk staat; leeg bij nul, zoals in de bestaande rapporten. */
  readonly label: string;
}

/**
 * Verdeling over 1..10 van de eindcijfers.
 *
 * **Afronden, niet afkappen.** De bestaande generator doet `Math.round(parseFloat(v))`, dus
 * een 7,5 telt als een 8. Overgenomen: het gaat om dezelfde staafdiagram als die ITG vandaag
 * verstuurt, en een andere afronding zou de verdeling stilletjes verschuiven.
 */
export function gradeDistribution(grades: readonly (number | null)[]): number[] {
  const buckets = Array.from({ length: GRADE_MAX }, () => 0);
  for (const grade of grades) {
    if (grade === null || !Number.isFinite(grade)) {
      continue;
    }
    const rounded = Math.round(grade);
    if (rounded >= GRADE_MIN && rounded <= GRADE_MAX) {
      buckets[rounded - GRADE_MIN] += 1;
    }
  }
  return buckets;
}

/** Verdeling over 1..5 voor de vijf schaalvragen. */
export function scoreDistribution(values: readonly (number | null)[]): number[] {
  const buckets = Array.from({ length: SCORE_MAX }, () => 0);
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) {
      continue;
    }
    const rounded = Math.round(value);
    if (rounded >= SCORE_MIN && rounded <= SCORE_MAX) {
      buckets[rounded - SCORE_MIN] += 1;
    }
  }
  return buckets;
}

/**
 * Balkhoogtes en bijschriften.
 *
 * **De percentages tellen niet altijd op tot 100.** Elk wordt apart afgerond, dus drie keer
 * 33,33% wordt drie keer 33%. Dat is wat de bestaande rapporten laten zien en het blijft zo;
 * grootste-rest-verdeling zou netter zijn maar elke bestaande grafiek net iets anders maken.
 *
 * Bij nul antwoorden is elke balk 0% in plaats van een deling door nul.
 */
export function bars(distribution: readonly number[]): Bar[] {
  const total = distribution.reduce((sum, n) => sum + n, 0);
  return distribution.map((count) => {
    const pct = total === 0 ? 0 : Math.round((count / total) * PERCENT);
    return { count, pct, label: count > 0 ? `${count} (${pct}%)` : '' };
  });
}

export interface FollowUp {
  readonly ja: number;
  readonly nee: number;
  readonly anders: number;
  /** `ja + nee + anders`. Blanco antwoorden tellen NIET mee. */
  readonly total: number;
}

/**
 * Ja / Nee / Anders, geteld uit vrije tekst.
 *
 * **Beide talen, ongeacht welk formulier.** Gemeten over de echte export: in het NEDERLANDSE
 * blad staan 20 keer `Yes` en 17 keer `No`. De taal is dus geen eigenschap van het blad, en
 * classificeren op herkomst zou die 37 antwoorden bij `Anders` zetten.
 *
 * **Exacte match, geen "begint met".** `No idea, depends on the group` en `Yes, but then
 * slightly shorter` komen allebei echt voor. Op voorvoegsel matchen maakt van de eerste een
 * `Nee`, en dat is het tegenovergestelde van wat er staat. Alles wat niet precies een van de
 * vier woorden is telt als `Anders` — zichtbaar in de taart, niet weggegooid, en niet geraden.
 *
 * Blanco telt nergens mee: 11.302 van de 14.211 rijen in het NL-blad hebben deze vraag niet
 * beantwoord (oudere formulierversies kenden hem niet), en die als `Anders` opvoeren zou de
 * taart onleesbaar maken.
 */
export function followUpTally(answers: readonly (string | null)[]): FollowUp {
  const YES = new Set(['ja', 'yes']);
  const NO = new Set(['nee', 'no']);
  let ja = 0;
  let nee = 0;
  let anders = 0;

  for (const answer of answers) {
    const value = (answer ?? '').trim().toLowerCase();
    if (value === '') {
      continue;
    }
    if (YES.has(value)) {
      ja += 1;
    } else if (NO.has(value)) {
      nee += 1;
    } else {
      anders += 1;
    }
  }

  return { ja, nee, anders, total: ja + nee + anders };
}

/**
 * Het gemiddelde zoals het in het rapport staat, of `null` als er niets te middelen valt.
 *
 * Eén decimaal met een PUNT, want dat is wat de huidige rapporten tonen — de bestaande
 * generator plakt er een JavaScript-getal in. Voor een Nederlands document is een komma
 * verdedigbaar; dat is een keuze voor ITG, geen technische.
 */
export function averageLabel(values: readonly (number | null)[]): string | null {
  const usable = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (usable.length === 0) {
    return null;
  }
  const mean = usable.reduce((sum, n) => sum + n, 0) / usable.length;
  return mean.toFixed(1);
}

/** Hoeveel respondenten deze vraag écht beantwoordden. */
export function answeredCount(values: readonly (number | null)[]): number {
  return values.filter((v) => v !== null && Number.isFinite(v)).length;
}
