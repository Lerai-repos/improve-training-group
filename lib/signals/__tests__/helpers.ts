import { SECTIES } from '@lib/briefingteksten/catalog';

import { findingName } from '../text';
import { SUMMARY_KEY } from '../write';

import type { TekstRij } from '@lib/briefingteksten/beoordeel';
import type { AgendaUsage } from '../findings';
import type { ExistingSignal } from '../reconcile';
import type { SignalGroupIds } from '../groups';
import type { Finding } from '../types';
import type { SignalWriter } from '../write';

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

/** Het bord Briefingteksten zoals `briefingteksten:create` het neerzet: geen enkele melding. */
export const VOLLEDIG_BORD: readonly TekstRij[] = SECTIES.map((s, i) => ({
  itemId: String(i),
  naam: s.naam,
  sleutel: s.sleutel,
  kop: s.kop,
  tekst: s.tekst,
  status: 'OK',
  melding: '',
}));

/** Een schrijver die alleen bijhoudt wat er gebeurde. */
export function spyWriter(): SignalWriter & {
  created: Array<{ naam: string; sleutel: string; soort: string }>;
  ticked: string[];
  summaries: string[];
  moved: Array<{ itemId: string; groupId: string }>;
  updated: Array<{ itemId: string; naam: string }>;
  reopened: Array<{ itemId: string; naam: string }>;
  cleared: string[];
} {
  const created: Array<{ naam: string; sleutel: string; soort: string }> = [];
  const ticked: string[] = [];
  const summaries: string[] = [];
  const moved: Array<{ itemId: string; groupId: string }> = [];
  const updated: Array<{ itemId: string; naam: string }> = [];
  const reopened: Array<{ itemId: string; naam: string }> = [];
  const cleared: string[] = [];
  return {
    updated,
    reopened,
    cleared,
    created,
    ticked,
    summaries,
    moved,
    create: async (f) => {
      created.push({ naam: f.naam, sleutel: f.sleutel, soort: f.soort });
      if (f.sleutel === SUMMARY_KEY) {
        summaries.push(f.detail);
      }
    },
    tick: async (s) => {
      ticked.push(s.itemId);
    },
    updateSummary: async (_id, detail) => {
      summaries.push(detail);
    },
    move: async (m) => {
      moved.push({ itemId: m.itemId, groupId: m.groupId });
    },
    update: async (itemId, fields) => {
      updated.push({ itemId, naam: fields.naam });
    },
    reopen: async (itemId, fields) => {
      reopened.push({ itemId, naam: fields.naam });
    },
    clearClosedBy: async (itemId) => {
      cleared.push(itemId);
    },
  };
}
