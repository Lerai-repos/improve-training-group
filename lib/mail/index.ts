export { composeMails, pdfBijlage, rapportBestandsnaam } from './compose';
export { deadlineSignal, remainingMs } from './deadline';
export { describeError } from './error-text';
export { createFailureStore, MAX_FAILURES } from './failure-store';
export { isTransient, MAIL_ATTEMPTS, sendWithRetry } from './retry';
export { buildMailFacts, dutchDate } from './facts';
export { createGraphMailSender, MailSendError } from './graph-sender';
export { isRedirected, MAIL_SENDER, mailRecipients } from './recipients';
export {
  CLAIM_TTL_MS,
  createSentGuard,
  deliveryNamespace,
  LUA_OWNED_WRITE,
  SENT_TTL_MS,
} from './sent-store';

export type { ComposedMail, ComposeInput, MailDoel } from './compose';
export type { FactsInput, MailFacts } from './facts';
export type { MailRecipients } from './recipients';
export type {
  ClaimResult,
  ClaimToken,
  MailVariant,
  OwnershipResult,
  SentGuard,
  SentStoreRedis,
} from './sent-store';
export type { FailureStore, MailFailure } from './failure-store';
export type { RetryOptions } from './retry';
export type { MailAttachment, MailSender, OutgoingMail } from './types';
