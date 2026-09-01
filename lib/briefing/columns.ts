/**
 * Waar elk veld van de briefing vandaan komt, geverifieerd tegen het live bord op
 * 19-Aug-2026 en niet tegen de specificatie alleen.
 *
 * De bron per veld staat in Dirkje's opmerkingen bij `2.0 ITG vb Briefing Probiblio …docx`.
 * Dat document is de enige plek waar die staan; de negen `.dotx`-sjablonen bevatten geen
 * enkele opmerking.
 */

import { AGENDA_2026_COLUMNS } from '@lib/monday/board-config';

/**
 * `TrainingColumnMap` heeft een paar optionele velden, omdat niet elk agendabord ze
 * allemaal heeft. De briefing kán er niet zonder: zonder `Tijden` is er geen datum-en-tijd
 * regel en geen materialen-deadline, en zonder `Taal` staat de voertaal er niet in.
 *
 * Dit valt om bij het laden en niet halverwege het genereren, zodat een verkeerd
 * geconfigureerd bord meteen opvalt in plaats van een briefing met lege rijen op te leveren.
 */
function requireColumn(id: string | undefined, naam: string): string {
  if (id === undefined || id.trim() === '') {
    throw new Error(`Briefing: het agendabord mist de kolom-id voor ${naam}`);
  }
  return id;
}

/** Kolommen op het agendabord die de briefing leest. */
export const BRIEFING_AGENDA_COLUMNS = {
  /**
   * `Bedrijf`, een mirror. Dirkje's v2.0-opmerking bij Opdrachtgever zegt letterlijk
   * "Bedrijf (Monday Agenda)" — niet de omweg via de Opportunity die de oudere spec
   * beschrijft.
   */
  opdrachtgever: AGENDA_2026_COLUMNS.companyMirror,
  themaRelation: AGENDA_2026_COLUMNS.themaRelation,
  klanttitel: 'tekst_mkmxrqwc',
  /**
   * LET OP: er zijn twee duur-kolommen en ze zijn allebei nodig.
   *
   * `dup__of_tijden` heet **Duur** en is tekst ("3 uur") — dat is wat de trainer leest.
   * `nummers_mkmvc0rk` heet **Exacte duur** en is een getal — daar rekent de
   * aanbevelingsengine mee. Ze door elkaar halen levert een briefing op met "3" of een
   * factuur op basis van de tekst "3 uur".
   */
  duurTekst: 'dup__of_tijden',
  datum: AGENDA_2026_COLUMNS.datum,
  tijden: requireColumn(AGENDA_2026_COLUMNS.tijd, 'Tijden'),
  deelnemers: 'deelnemersaantal__1',
  locatie: AGENDA_2026_COLUMNS.locatie,
  taal: requireColumn(AGENDA_2026_COLUMNS.taal, 'Taal'),
  /** People-kolom. Gevuld op 815/815; het mobiele nummer komt uit `users`, zie hieronder. */
  accountmanager: 'mensen',
  /**
   * De náám van de contactpersoon. 690/815 gevuld en **nooit een telefoonnummer**:
   * gemeten, 0 van 815 bevat iets dat op een nummer lijkt.
   *
   * `tekst24` ("Contactpersoon") is een strikte deelverzameling hiervan — 107 items, geen
   * enkele afwijkende waarde, nooit alleen gevuld — dus die kolom voegt niets toe.
   */
  contactpersoonNaam: 'tekst8',
  klantcontactmoment: 'status3',
  qr: 'dup__of_cert',
  ieCode: AGENDA_2026_COLUMNS.ieCode,
  label: requireColumn(AGENDA_2026_COLUMNS.label, 'Label'),
  /** De **leadtrainer**; sinds 21-Aug-2026 draagt deze kolom alleen de lead. */
  trainerRelation: AGENDA_2026_COLUMNS.trainerRelation,
  /**
   * De co-trainers, `itg_cotrainers`, door ons aangemaakt met `pnpm agenda:cotrainer`.
   *
   * Verplicht en niet optioneel: zodra ITG hier iemand in zet en de briefing leest hem
   * niet, staat er een document bij de trainer waarin een collega ontbreekt die die dag
   * gewoon meedraait.
   */
  coTrainerRelation: requireColumn(AGENDA_2026_COLUMNS.coTrainerRelation, 'Co-trainer(s)'),
  /** De briefing-statuskolom die het proces stuurt. */
  brie: 'dup__of_brie7__1',
  /**
   * `Acteuraantal`. **Een aanwijzing, geen waarheid.** Gemeten over 815 trainingen: 551
   * gevuld, waarvan 517 een `0`, dus 34 echte acteurs — en **264 leeg**. Leeg is niet
   * nul, dus "geen acteur" en "niet ingevuld" zijn hier niet te onderscheiden.
   *
   * Wel geruststellend: 28 van die 34 hebben precies twee gekoppelde trainers, wat er
   * uitziet als trainer plus acteur. Daarom vult dit de checklistvraag vóór, en bevestigt
   * de adviseur.
   */
  acteuraantal: 'numeric_mm0nhbn7',
  /** Naar het Opportunitybord (1279052045), voor de contactpersoon en zijn nummer. */
  opportunity: 'board_relation',
} as const;

/** Het Opportunitybord waar de agenda naartoe koppelt. */
export const OPPORTUNITY_BOARD = '1279052045';

export const OPPORTUNITY_COLUMNS = {
  /** Board relation naar `Contacten 👫` (1279052020). */
  contact: 'deal_contact',
  /**
   * De achtergrondinformatie, bij ITG "de aanleidingtekst". Aangemaakt door ons met
   * `pnpm opportunity:achtergrond`.
   *
   * Dirkje in `docs/correspondence/correspondence_august.md`: *"Denk dan in het opportunitybord
   * een lang tekstveld. We gebruiken wel altijd meerdere alinea's."* Vandaar `long_text` en
   * niet `text`.
   *
   * **Niet te verwarren met `beschrijving_2_0`** ("Beschrijving"), dat al op dit bord staat:
   * daar staat de aanvraag van de klant zelf in, in de ik-vorm, inclusief dingen als "ik ben
   * dinsdag telefonisch bereikbaar". Hooguit grondstof, geen briefingtekst.
   */
  achtergrond: 'itg_achtergrond',
} as const;

/**
 * Het Themas-bord, waar het agendabord met `themaRelation` naartoe koppelt.
 *
 * Let op: **er staan dubbele items op**. `Focus en aandacht` komt twee keer voor en
 * `Teamcoaching` ook. Alleen het eerste item bijwerken laat de helft van de trainingen met
 * een leeg veld achter, en dat is niet te onderscheiden van een thema dat nooit een skelet
 * heeft gekregen.
 */
/**
 * De MC-productcode per label, één kolom per label op het Themabord.
 *
 * Acht kolommen en niet één, want de code verschilt per thema ÉN per label: "Verbindend
 * communiceren" is IT-58 maar JE-60, TT-27, SST-45 en CC-64. Er zit geen gedeelde nummering
 * in, dus afleiden uit labelcode plus themanummer kan niet — gemeten, en door ITG bevestigd.
 *
 * Aangemaakt met `scripts/themas-mc-codes.ts`, gevuld met `scripts/themas-mc-seed.ts`.
 *
 * ## FT en TMT staan er MET OPZET niet in
 *
 * ITG's werkblad heeft een negende blok, `Losse labels`: `Feedback Trainer → FT-1` en
 * `Time Management Trainer → TMT-1`. Dat zijn codes voor een héél label, zonder thema — ze
 * passen dus niet in een kolom per thema, en er is geen bordthema om ze aan te hangen.
 *
 * Belangrijker: **die challenges bestaan nog niet.** Dirkje, 27-Aug-2026: *"deze challenges
 * zijn nog helemaal niet gemaakt... We hebben die automatisering alleen nog niet klaar dus
 * die bestaat nog niet."* `FT-1` op een briefing zetten zou de trainer vragen iets aan te
 * bieden dat ITG niet heeft — dezelfde fout als het wegschrijven van `NOG MAKEN`.
 *
 * Een FT-briefing krijgt dus een lege Trainingscode-regel, en dat is de bedoeling. Wie hier
 * later een `FT`-kolom bijzet lost een probleem op dat niet bestaat en introduceert een
 * verzonnen product; vraag eerst aan ITG of de challenge inmiddels wél gemaakt is. TMT is
 * bovendien geen briefinglabel (`SUPPORTED_LABELS` kent het niet), dus die speelt helemaal
 * niet mee.
 */
export const THEMAS_MC_COLUMNS: Readonly<Record<string, string>> = {
  IT: 'itg_mc_it',
  JE: 'itg_mc_je',
  TT: 'itg_mc_tt',
  SST: 'itg_mc_sst',
  FV: 'itg_mc_fv',
  WJ: 'itg_mc_wj',
  CC: 'itg_mc_cc',
  CP: 'itg_mc_cp',
};

export const THEMAS_COLUMNS = {
  /**
   * De concept-inhoud per thema: de 85 skeletten uit `ITG - Training skeletten 2024.docx`.
   *
   * `long_text` en niet `text`, want het zijn twaalf regels per thema en een `text`-kolom
   * kapt af. Eén bullet per regel; de organisatienaam staat er als `{organisatie}` in en
   * wordt bij het genereren ingevuld — zie `concept.ts`.
   *
   * Gevuld met `pnpm themas:conceptinhoud --apply`.
   */
  conceptInhoud: 'itg_conceptinhoud',
} as const;

/**
 * Het Briefings-bord: het register van gegenereerde briefings, één rij per document.
 *
 * Aangemaakt 21-Aug-2026 met `pnpm briefings:create --apply`.
 *
 * **De drie spiegelkolommen (`itg_klant`, `itg_datum`, `itg_thema`) zijn met de hand
 * gekoppeld**, want Monday's API maakt een mirror-kolom wel aan maar negeert de configuratie
 * volledig: `create_column` meldt succes en `settings_str` blijft `{}`. Gemeten met drie
 * verschillende vormen. Controleer dus na elke bordwijziging of ze nog ergens naartoe wijzen —
 * een niet-gekoppelde spiegel ziet er hetzelfde uit als een lege.
 */
export const BRIEFINGS_BOARD = '5102783564';

export const BRIEFINGS_COLUMNS = {
  /** board_relation naar het agendabord. Draagt de betekenis; de spiegels zijn weergave. */
  training: 'itg_training',
  klant: 'itg_klant',
  datum: 'itg_datum',
  thema: 'itg_thema',
  /** De trainer voor wie déze kopie is. */
  ontvanger: 'itg_ontvanger',
  /** status: Leadtrainer / Co-trainer / Trainingsacteur. */
  rol: 'itg_rol',
  bestandslink: 'itg_bestandslink',
  gegenereerd: 'itg_gegenereerd',
} as const;

/**
 * De groep `Acteurs` op het trainersbord (1661151090).
 *
 * De trainerrelatie op de agenda bevat trainers **en** acteurs door elkaar, dus zonder dit
 * onderscheid telt een acteur mee als co-trainer en krijgt de trainer een blok over een
 * co-trainer die niet bestaat.
 *
 * Gemeten over 823 trainingen, 15 mensen in de groep:
 *
 * | Situatie | Aantal |
 * |---|---|
 * | `Acteuraantal=1`, 2 gekoppeld, 1 daarvan zit in de groep | 20 |
 * | `Acteuraantal=1`, 2 gekoppeld, geen enkele in de groep | 8 |
 * | `Acteuraantal` leeg, maar er hángt wel een acteur aan | 5 |
 *
 * Dus: de groep is het beste signaal dat er is, maar hij is **niet volledig**. Daarom is hij
 * alleen goed genoeg om iemand als acteur te herkennen, en nooit om te concluderen dat er
 * géén acteur is. Dat laatste beantwoordt de adviseur in de checklist.
 */
export { TRAINER_ACTEURS_GROUP } from '@lib/monday/board-config';

/**
 * Het contactenbord. Het telefoonnummer staat hier en nergens anders.
 *
 * Gemeten: ~49% gevuld (147 van 300). Dus een flink deel van de briefings krijgt een naam
 * zónder nummer, en de opmaak moet daar netjes op terugvallen in plaats van lege haakjes
 * af te drukken.
 */
export const CONTACT_COLUMNS = {
  telefoon: 'tekst__1',
} as const;

/**
 * Een Nederlands mobiel nummer in de vorm die de briefing gebruikt: `06-48431025`.
 *
 * Monday levert per bron iets anders op — `+31 6 36331302`, `+31648431025`,
 * `+31(0) 6 57836652` — en de voorbeeldbriefing schrijft `06-48431025`. Alles wat we niet
 * herkennen geven we onveranderd terug: een half genormaliseerd nummer is erger dan een
 * lelijk maar kloppend nummer.
 */
export function formatDutchMobile(raw: string | null | undefined): string {
  const input = (raw ?? '').trim();
  if (input === '') {
    return '';
  }
  const digits = input.replace(/\D/g, '');
  const national = digits.startsWith('31') ? digits.slice(2) : digits;
  const withoutTrunk = national.startsWith('0') ? national.slice(1) : national;
  if (withoutTrunk.length !== 9 || !withoutTrunk.startsWith('6')) {
    return input;
  }
  return `0${withoutTrunk.slice(0, 1)}-${withoutTrunk.slice(1)}`;
}

/** `Paula Hollander (06-42085076)`, of alleen de naam als er geen nummer is. */
export function formatContact(naam: string, telefoon: string): string {
  const name = naam.trim();
  const phone = formatDutchMobile(telefoon);
  if (name === '') {
    return '';
  }
  return phone === '' ? name : `${name} (${phone})`;
}

/** `Dirkje Pril / 06-48431025`, de opmaak van de accountmanager-rij. */
export function formatAccountmanager(naam: string, mobiel: string): string {
  const phone = formatDutchMobile(mobiel);
  const name = naam.trim();
  if (name === '') {
    return '';
  }
  return phone === '' ? name : `${name} / ${phone}`;
}
