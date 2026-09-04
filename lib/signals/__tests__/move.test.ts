import { describe, expect, it } from 'vitest';

import { groupMoves, staleClosedByMarkers } from '../move';
import { SUMMARY_KEY } from '../write';

import { GROUPS, signal } from './helpers';

describe('groupMoves', () => {
  it('verplaatst niets als alles al goed staat', () => {
    expect(
      groupMoves({ existing: [signal()], resolvedIds: [], reopenedIds: [], groups: GROUPS })
    ).toEqual([]);
  });

  it('haalt een met de hand afgevinkte melding uit de openstaande groep', () => {
    const moves = groupMoves({
      existing: [signal({ afgehandeld: true })],
      resolvedIds: [],
      reopenedIds: [],
      groups: GROUPS,
    });
    expect(moves).toEqual([{ itemId: 'i1', groupId: 'g_klaar', from: 'g_open' }]);
  });

  /**
   * `existing` is gelezen vóór de mutaties, dus een melding die deze run is afgevinkt staat
   * daar nog op `afgehandeld: false`. Zonder `resolvedIds` verhuist hij pas de volgende nacht
   * en staat er een dag lang een afgeronde regel tussen wat er nog ligt.
   */
  it('verplaatst ook wat deze run zelf is afgevinkt', () => {
    const moves = groupMoves({
      existing: [signal()],
      resolvedIds: ['i1'],
      reopenedIds: [],
      groups: GROUPS,
    });
    expect(moves).toEqual([{ itemId: 'i1', groupId: 'g_klaar', from: 'g_open' }]);
  });

  it('zet een ontvinkte melding weer terug bij de openstaande', () => {
    const moves = groupMoves({
      existing: [signal({ afgehandeld: false, groupId: 'g_klaar' })],
      resolvedIds: [],
      reopenedIds: [],
      groups: GROUPS,
    });
    expect(moves).toEqual([{ itemId: 'i1', groupId: 'g_open', from: 'g_klaar' }]);
  });

  it('houdt de samenvatting in haar eigen groep, ook als die nooit wordt afgevinkt', () => {
    expect(
      groupMoves({
        existing: [signal({ key: SUMMARY_KEY, groupId: 'g_sam' })],
        resolvedIds: [],
        reopenedIds: [],
        groups: GROUPS,
      })
    ).toEqual([]);
  });

  it('haalt de samenvatting terug uit de meldingengroep', () => {
    const moves = groupMoves({
      existing: [signal({ key: SUMMARY_KEY, groupId: 'g_open' })],
      resolvedIds: [],
      reopenedIds: [],
      groups: GROUPS,
    });
    expect(moves).toEqual([{ itemId: 'i1', groupId: 'g_sam', from: 'g_open' }]);
  });

  it('laat een rij zonder sleutel staan waar hij staat', () => {
    // Iemands eigen aantekening op het bord. Die is niet van ons om rond te schuiven — ook
    // niet als er een vinkje in staat.
    expect(
      groupMoves({
        existing: [signal({ key: '', afgehandeld: true, groupId: 'g_open' })],
        resolvedIds: [],
        reopenedIds: [],
        groups: GROUPS,
      })
    ).toEqual([]);
  });

  it('verplaatst meerdere rijen in één keer, elk naar zijn eigen groep', () => {
    const moves = groupMoves({
      existing: [
        signal({ itemId: 'a', afgehandeld: true, groupId: 'g_open' }),
        signal({ itemId: 'b', key: 'thema-zonder-inhoud:12', groupId: 'g_klaar' }),
        signal({ itemId: 'c', key: SUMMARY_KEY, groupId: 'g_sam' }),
      ],
      resolvedIds: [],
      reopenedIds: [],
      groups: GROUPS,
    });
    expect(moves).toEqual([
      { itemId: 'a', groupId: 'g_klaar', from: 'g_open' },
      { itemId: 'b', groupId: 'g_open', from: 'g_klaar' },
    ]);
  });
});

describe('groupMoves — heropenen', () => {
  /**
   * `existing` is de foto van vóór de mutaties: een heropende rij staat daar nog als
   * afgevinkt. Zonder `reopenedIds` zou hij dus in Afgehandeld blijven staan terwijl het
   * vinkje er inmiddels uit is — een rij die zegt dat hij openstaat, op de plek voor
   * afgeronde dingen.
   */
  it('zet een heropende melding terug bij de openstaande, ondanks de oude foto', () => {
    const moves = groupMoves({
      existing: [signal({ afgehandeld: true, groupId: 'g_klaar' })],
      resolvedIds: [],
      reopenedIds: ['i1'],
      groups: GROUPS,
    });
    expect(moves).toEqual([{ itemId: 'i1', groupId: 'g_open', from: 'g_klaar' }]);
  });

  it('verplaatst een heropende rij niet als hij al bij de openstaande stond', () => {
    expect(
      groupMoves({
        existing: [signal({ afgehandeld: true, groupId: 'g_open' })],
        resolvedIds: [],
        reopenedIds: ['i1'],
        groups: GROUPS,
      })
    ).toEqual([]);
  });
});

describe('staleClosedByMarkers', () => {
  const geen = { reopenedIds: [], resolvedIds: [] };

  /**
   * Ontstaat zo: de controle vinkt af (marker `controle`), iemand haalt het vinkje er met de
   * hand weer uit, de marker blijft staan. Vinkt diezelfde persoon hem later opnieuw af — nu
   * als besluit — dan leest `reconcile` nog steeds "afgevinkt door de controle" en heropent
   * hem tegen hun bedoeling in.
   */
  it('vindt een marker op een rij waar het vinkje uit is', () => {
    expect(
      staleClosedByMarkers([signal({ afgehandeld: false, closedByCheck: true })], geen)
    ).toEqual(['i1']);
  });

  it('laat een marker staan zolang het vinkje er nog in zit', () => {
    expect(
      staleClosedByMarkers([signal({ afgehandeld: true, closedByCheck: true })], geen)
    ).toEqual([]);
  });

  it('raakt een rij zonder marker niet aan', () => {
    expect(
      staleClosedByMarkers([signal({ afgehandeld: false, closedByCheck: false })], geen)
    ).toEqual([]);
  });

  it('slaat over wat deze run zelf is heropend — die schrijfactie maakte hem al leeg', () => {
    expect(
      staleClosedByMarkers([signal({ afgehandeld: false, closedByCheck: true })], {
        reopenedIds: ['i1'],
        resolvedIds: [],
      })
    ).toEqual([]);
  });
});

describe('staleClosedByMarkers — de rij die tegelijk stale én opgelost is', () => {
  /**
   * Het vinkje stond uit (marker dus verouderd) en het probleem is deze run verdwenen, dus er
   * wordt afgevinkt. `tick` schrijft `controle` in de marker. Zou de opruiming daarna nog
   * langskomen — die werkt op de foto van vóór de mutaties — dan maakt hij die marker meteen
   * weer leeg, leest de rij als "door een mens weggezet", en komt de melding bij terugkeer van
   * het probleem nooit meer terug.
   */
  it('slaat een rij over die deze run is afgevinkt', () => {
    expect(
      staleClosedByMarkers([signal({ itemId: 'x', afgehandeld: false, closedByCheck: true })], {
        reopenedIds: [],
        resolvedIds: ['x'],
      })
    ).toEqual([]);
  });
});
