import { findingName } from '../text';

import type { AgendaUsage } from '../findings';
import type { ExistingSignal } from '../reconcile';
import type { SignalGroupIds } from '../groups';
import type { Finding } from '../types';

export const GROUPS: SignalGroupIds = {
  samenvatting: 'g_sam',
  open: 'g_open',
  afgehandeld: 'g_klaar',
};

/**
 * Een rij zoals die op het Systeem-bord staat.
 *
 * `naam` heeft met opzet GEEN nuttige standaardwaarde: de vergelijking tussen `naam` en
 * `findingName(finding)` is wat "er is niets veranderd" onderscheidt van "de cijfers zijn
 * verschoven". Een helper die de goede naam zou raden zou dat onderscheid wegtesten.
 * Gebruik `rowFor(finding)` als je een rij wilt die exact overeenkomt.
 */
export const signal = (over: Partial<ExistingSignal> = {}): ExistingSignal => ({
  itemId: 'i1',
  naam: 'een melding',
  key: 'onbekend-label:TMT',
  afgehandeld: false,
  detail: 'oud detail',
  groupId: GROUPS.open,
  closedByCheck: false,
  ...over,
});

/** De rij die precies bij deze vondst hoort — dus één waar niets aan veranderd is. */
export const rowFor = (finding: Finding, over: Partial<ExistingSignal> = {}): ExistingSignal =>
  signal({ naam: findingName(finding), ...over });

/**
 * Wat de agenda oplevert. Alle drie de tellingen standaard leeg, zodat een test alleen noemt
 * wat hij daadwerkelijk onderzoekt — en een nieuw veld hier niet elke test aanpast.
 */
export const usage = (over: Partial<AgendaUsage> = {}): AgendaUsage => ({
  labels: new Map(),
  themas: new Map(),
  trainers: new Map(),
  ...over,
});
