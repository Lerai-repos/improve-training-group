import type { ReportRunOutcome } from './run';

/**
 * Wat er van een run overblijft zodra je het document zelf niet meer nodig hebt.
 *
 * De dagjob rendert NIET: zolang er geen mailbox is heeft een PDF nergens heen te gaan, en
 * `04-evaluatierapportage.md` is er duidelijk over dat de mail de aflevering is — het bestand
 * wordt nergens bewaard. Vijftien PDF's per ochtend maken die niemand ooit opent is pure
 * verspilling van een Chromium-start per training. Het BORD bijwerken moet wel elke dag, en
 * daar is dit type voor.
 */
export type EvalResult =
  | { readonly kind: 'ok'; readonly responseCount: number; readonly gemiddelde: string | null }
  | { readonly kind: 'no_responses' }
  | { readonly kind: 'no_code' }
  | { readonly kind: 'unknown_label' }
  | { readonly kind: 'missing_trainer' }
  /**
   * De code is niet eenduidig toe te wijzen.
   *
   * Er ZIJN reacties, maar meerdere trainingen van verschillende klanten claimen dezelfde
   * code, dus de toekenning houdt ze bewust tegen. Fundamenteel iets anders dan "niemand
   * heeft ingevuld", en het vraagt om een andere oplossing: ITG moet de dubbele code
   * herstellen, niet achter deelnemers aan.
   */
  | { readonly kind: 'ambiguous_code' }
  | { readonly kind: 'not_found' };

/** De uitkomst van een volledige run, teruggebracht tot wat het bord nodig heeft. */
export function evalResultOf(outcome: ReportRunOutcome): EvalResult {
  if (outcome.kind === 'ok') {
    return {
      kind: 'ok',
      responseCount: outcome.report.responseCount,
      gemiddelde: outcome.report.gemiddeldeBeoordeling,
    };
  }
  return { kind: outcome.kind };
}

/**
 * Wat er na een rapportrun op het agenda-item komt te staan.
 *
 * `04-evaluatierapportage.md`: *"Op het Monday agenda-item: eindcijfer, aantal respondenten,
 * en de status."* Die twee getalkolommen bestonden nog niet — gemeten op het live bord, de
 * enige getalkolommen daar zijn Trainers nummer, Acteuraantal, O, Uren en Exacte duur — dus
 * `pnpm agenda:evalkolommen` maakt ze aan.
 */

/** Door ons aangemaakt; vastgepind op id zodat ITG mag hernoemen. */
export const EVAL_COLUMNS = {
  eindcijfer: 'itg_eindcijfer',
  respondenten: 'itg_respondenten',
} as const;

/**
 * `IE. Trainer` (`dup__of_qr`) — bestond al, mét het label `Onvindbaar`.
 *
 * Let op: `04-evaluatierapportage.md` noemt deze kolom `Ind. Ev.`; op het bord heet hij
 * `IE. Trainer`. Zelfde kolom, andere naam — daarom zoeken we op id.
 */
export const IE_STATUS_COLUMN = 'dup__of_qr';

/** Het label uit de bestaande set dat "er is gezocht en niets gevonden" betekent. */
export const IE_STATUS_ONVINDBAAR = 'Onvindbaar';

/**
 * De neutrale toestand van deze kolom: ongesorteerd, nog niet beoordeeld.
 *
 * `IE` is Monday's lege index-5-vak waar ITG een naam op heeft gezet — het is dan ook precies
 * wat Monday schrijft als je de kolom "wist". Gemeten over het hele bord: van de zes labels
 * heeft alleen `IE` een gemengde bezetting (134 items, 54% met een IE-code), terwijl
 * `Verzonden`, `Onvindbaar` en `Staat klaar` alle drie 100% een code hebben en
 * `Geen (deze sessie)` maar 3%. Dat maakt `IE` de restbak en niet een werkstroomstap.
 *
 * Daarom is dit de juiste waarde om een achterhaalde `Onvindbaar` mee te overschrijven: de
 * rij gaat terug de gewone stroom in (Aanmaken → Staat klaar → Verzonden) in plaats van te
 * blijven beweren dat er niets gevonden is.
 */
export const IE_STATUS_NEUTRAAL = 'IE';

export interface EvalWrite {
  /** `column_values` voor Monday. Leeg betekent: niets te schrijven. */
  readonly values: Record<string, unknown>;
  /** Mensentaal, voor het logboek en de droogloop. */
  readonly summary: string;
}

/** Wat er NU op het item staat; nodig om oude uitkomsten op te ruimen. */
export interface CurrentState {
  /** De huidige waarde van `IE. Trainer`. */
  readonly ieStatus: string;
}

/** Een lege waarde wist een getalkolom; weglaten laat de oude waarde staan. */
const CLEAR_NUMBER = '';

/**
 * Van uitkomst naar bordwaarden.
 *
 * Puur, zodat elke tak te toetsen is zonder Monday — en omdat dit de plek is waar een fout
 * stilletjes verkeerde cijfers op een klantregel zet.
 *
 * **De statuskolom wordt alléén op `Onvindbaar` gezet.** Bij een geslaagd rapport blijft hij
 * met opzet ongemoeid: de overige labels (`Verzonden`, `Staat klaar`) gaan over de mail, en
 * die versturen wij nog niet. Een status die "verzonden" beweert terwijl er niets verstuurd
 * is, is erger dan geen status.
 */
export function evalWriteFor(result: EvalResult, current: CurrentState): EvalWrite {
  /**
   * Was de vorige uitkomst van ONS?
   *
   * Alleen `Onvindbaar` zetten wij; `Verzonden`, `Staat klaar` en `IE` horen bij de
   * mailstap en bij ITG's eigen werkstroom. Die mogen hier nooit overschreven worden.
   */
  const onsOnvindbaar = current.ieStatus.trim() === IE_STATUS_ONVINDBAAR;

  switch (result.kind) {
    case 'ok': {
      /**
       * Het cijfer als GETAL, niet als de tekst uit het rapport.
       *
       * In het document staat "8.0" omdat dat leest als een cijfer; een getalkolom hoort de
       * waarde te krijgen, zodat ITG erop kan sorteren en filteren.
       */
      const gemiddelde = Number(result.gemiddelde);
      const heeftCijfer = result.gemiddelde !== null && Number.isFinite(gemiddelde);
      const values: Record<string, unknown> = {
        [EVAL_COLUMNS.respondenten]: result.responseCount,
        /**
         * Het cijfer altijd SCHRIJVEN, ook als er geen is — dan als lege waarde.
         *
         * Weglaten laat een oud cijfer staan. Draaide de vorige run met cijfers en deze
         * met alleen blanco beoordelingen, dan zou er een verouderd cijfer naast het
         * nieuwe aantal blijven staan, en niets verraadt dat het van een andere run is.
         */
        [EVAL_COLUMNS.eindcijfer]: heeftCijfer ? gemiddelde : CLEAR_NUMBER,
      };
      /**
       * Een achterhaalde `Onvindbaar` overschrijven zodra er wél reacties zijn.
       *
       * Anders staat er "niets gevonden" naast een cijfer en een aantal respondenten — twee
       * tegenstrijdige beweringen op één regel, waarvan de eerste aantoonbaar onwaar is.
       *
       * ALLEEN vanuit `Onvindbaar`. `Verzonden`, `Staat klaar`, `Aanmaken` en
       * `Geen (deze sessie)` horen bij ITG's eigen werkstroom en bij de mailstap; die blijven
       * onaangeroerd, ook als er reacties binnenkomen.
       */
      if (onsOnvindbaar) {
        values[IE_STATUS_COLUMN] = { label: IE_STATUS_NEUTRAAL };
      }
      return {
        values,
        summary:
          `${result.responseCount} reacties, gemiddeld ${result.gemiddelde ?? '—'}` +
          (onsOnvindbaar
            ? `; ${IE_STATUS_ONVINDBAAR} → ${IE_STATUS_NEUTRAAL} (reacties alsnog gevonden)`
            : ''),
      };
    }

    case 'no_responses':
      /**
       * De situatie die ITG in februari aanvroeg en die nooit gebouwd is. Het bord is bewust
       * de eerste signalering: een mail wordt gemist, en hier werken ze toch al.
       */
      return {
        values: {
          [IE_STATUS_COLUMN]: { label: IE_STATUS_ONVINDBAAR },
          [EVAL_COLUMNS.respondenten]: 0,
          // Ook hier wissen: een cijfer van een eerdere run naast nul respondenten is een
          // tegenspraak die er verzorgd uitziet.
          [EVAL_COLUMNS.eindcijfer]: CLEAR_NUMBER,
        },
        summary: `status → ${IE_STATUS_ONVINDBAAR} (nul reacties)`,
      };

    case 'no_code':
    case 'unknown_label':
    case 'missing_trainer':
    case 'ambiguous_code':
    case 'not_found':
      /**
       * Niets schrijven. Zonder code is er nooit een evaluatie uitgezet, dus `Onvindbaar`
       * zou een zoekactie suggereren die niet heeft plaatsgevonden; bij een onbekend label
       * ligt het probleem in de configuratie en niet bij deze training. En bij een dubbele
       * code bestaan de reacties wél — `Onvindbaar` zou daar ronduit onwaar zijn.
       */
      return { values: {}, summary: 'niets geschreven' };
  }
}
