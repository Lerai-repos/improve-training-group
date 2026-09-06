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
  /**
   * De hele body als platte tekst.
   *
   * Platte tekst en geen HTML, omdat deze mail bedoeld is om **overgenomen** te worden: de
   * accountmanager plakt hem in zijn eigen bericht aan de klant. Opmaak die in ons bericht
   * mooi staat, verandert bij het plakken in andermans lettertype en kleuren, en de
   * markeringen die aangeven wat ITG zelf moet invullen zouden juist dán wegvallen. In
   * platte tekst blijft `[ZO IETS]` overal `[ZO IETS]`.
   */
  readonly body: string;
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
