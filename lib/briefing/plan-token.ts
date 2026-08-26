import { createHash } from 'node:crypto';

/**
 * De vingerafdruk van een plan, en het antwoord op "wat is er veranderd?".
 *
 * `confirmExisting: true` zegt alleen "ja, doe maar" — niet wáár ja tegen. Tussen het tonen
 * van een plan en het bevestigen ervan kan er van alles gebeurd zijn: een collega zet een
 * bestand in de map, of past de checklist aan. Zonder deze controle geldt de bevestiging dan
 * voor iets wat niemand heeft gezien.
 *
 * Apart van de route omdat een Next-route alleen HTTP-handlers mag exporteren — en dit is
 * precies het soort beslissing dat een test verdient.
 */

/** Genoeg om een botsing uit te sluiten, kort genoeg om in een log te passen. */
const FINGERPRINT_LENGTH = 32;

export interface PlanFingerprintInput {
  readonly folderPath: string;
  readonly folderExists: boolean;
  readonly filenames: readonly string[];
  readonly conflicts: readonly string[];
  /** Het token van de opgeslagen checklist: verandert zodra iemand een antwoord wijzigt. */
  readonly checklistToken: string;
}

const hash = (waarde: unknown): string =>
  createHash('sha256').update(JSON.stringify(waarde)).digest('hex').slice(0, FINGERPRINT_LENGTH);

/**
 * Twee helften in één ondoorzichtig token.
 *
 * "Het plan is verschoven" heeft twee heel verschillende oorzaken, en de adviseur moet ze uit
 * elkaar kunnen houden. Zijn er bestanden bij gekomen, dan hoort hij die te zien. Is de
 * CHECKLIST gewijzigd door een collega, dan staat het formulier nog met zíjn oude antwoorden
 * terwijl de volgende generatie op die van de collega gebouwd zou worden — en dan moet het
 * scherm eerst opnieuw laden in plaats van hem te laten bevestigen.
 *
 * Voor de client blijft het één ondoorzichtige string.
 */
export function planFingerprint(input: PlanFingerprintInput): string {
  return [
    hash({
      folderPath: input.folderPath,
      folderExists: input.folderExists,
      filenames: [...input.filenames].sort(),
      conflicts: [...input.conflicts].sort(),
    }),
    hash(input.checklistToken),
  ].join('.');
}

/**
 * Alles aan een training dat in het document terechtkomt, als één vingerafdruk.
 *
 * De bestandsnaam dekt maar vier velden — klant, thema, datum, trainer. Locatie, tijden,
 * groepsgrootte, voertaal, contactpersoon, achtergrondinformatie en telefoonnummers staan
 * wél in de briefing maar niet in de naam, en kunnen dus tijdens het renderen wijzigen
 * zonder dat er iets opvalt. Dan gaat er een document de deur uit met gegevens die op het
 * bord allang anders zijn.
 *
 * Bewust over het hele object en niet over een handgeschreven lijstje velden: een veld dat
 * later aan `BriefingTraining` wordt toegevoegd hoort er meteen in te zitten, en dat gebeurt
 * alleen als niemand hoeft te onthouden dat deze lijst bestaat.
 */
export function trainingFingerprint(training: unknown): string {
  return hash(stabiel(training));
}

/**
 * Hetzelfde object, met de sleutels overal gesorteerd.
 *
 * `JSON.stringify` volgt de invoegvolgorde, en die hangt bij Monday af van de volgorde
 * waarin kolommen terugkomen. Zonder dit zou een identieke training soms een andere
 * vingerafdruk krijgen en zouden we een wijziging melden die er niet is.
 */
function stabiel(waarde: unknown): unknown {
  if (Array.isArray(waarde)) {
    return waarde.map(stabiel);
  }
  if (waarde === null || typeof waarde !== 'object') {
    return waarde;
  }
  return Object.fromEntries(
    Object.entries(waarde)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sleutel, inhoud]) => [sleutel, stabiel(inhoud)])
  );
}

/**
 * Welke helft niet meer klopt — en dus wat de adviseur moet doen.
 *
 * Beide helften apart vergelijken, en de invoer wint. Veranderde er alleen een bestand, dan
 * klopt het formulier op het scherm nog. Veranderde de checklist, dan niet — en dat blijft
 * waar, óók als er tegelijk een bestand bij kwam. Alleen op het bestandsdeel toetsen las die
 * dubbele wijziging als `files`, waarna het scherm de verouderde antwoorden liet staan en
 * gewoon liet bevestigen.
 */
export function planChangeReason(gekregen: string | undefined, huidig: string): 'input' | 'files' {
  const [bestanden, invoer] = huidig.split('.');
  const [gekregenBestanden, gekregenInvoer] = (gekregen ?? '').split('.');
  if (gekregenInvoer !== invoer) {
    return 'input';
  }
  return gekregenBestanden === bestanden ? 'input' : 'files';
}
