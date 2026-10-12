/**
 * Wat er verstuurd wordt, los van hoe.
 *
 * De vier mailvarianten uit `04-evaluatierapportage.md` gaan **niet** naar de klant of de
 * trainer zelf: ze gaan naar twee gedeelde postbussen van ITG, die ze nakijken, de rode
 * stukken invullen en dan pas doorsturen. Wij leveren dus een concept áán op een echt adres
 * — geen conceptmap in iemands postvak.
 */

/** Eén bijlage. `bytes` is het bestand zelf; niets hier weet dat het een PDF is. */
export interface MailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface OutgoingMail {
  readonly to: readonly string[];
  readonly subject: string;
  /** De body als platte tekst: voor de droogloop en het logboek, niet om te versturen. */
  readonly body: string;
  /**
   * Wat er verstuurd wordt: dezelfde regels als `body`, met de kopjes dikgedrukt en alles in
   * Calibri 11.
   *
   * Eerst was dit bewust platte tekst, omdat de accountmanager de mail overneemt en opmaak bij
   * het plakken zou verspringen. ITG vroeg op 12-Oct-2026 om de opmaak van vóór de overstap
   * terug (die mails waren ook HTML). Het lettertype staat daarom op elke alinea, zodat het
   * meegaat bij het plakken, en `[ZO IETS]` blijft gewoon tekst.
   */
  readonly html: string;
  readonly attachment?: MailAttachment;
}

/**
 * De poort naar buiten. Eén methode, zodat de dagjob getest kan worden zonder Graph.
 *
 * Werpt bij mislukking; de aanroeper beslist wat een mislukte mail betekent voor de rest
 * van de dag.
 */
export interface MailSender {
  send(mail: OutgoingMail): Promise<void>;
}
