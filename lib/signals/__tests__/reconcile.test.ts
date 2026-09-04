import { describe, expect, it } from 'vitest';

import { reconcile } from '../reconcile';
import { rowForFinding } from '../text';
import { findingKey } from '../types';

import { signal } from './helpers';

import type { ExistingSignal } from '../reconcile';
import type { Finding } from '../types';

const LABEL_KINDS: readonly string[] = ['onbekend-label', 'label-ontbreekt', 'label-onvolledig'];
const THEMA_KINDS: readonly string[] = ['thema-ontbreekt', 'thema-zonder-inhoud'];
const ALL: readonly string[] = [...LABEL_KINDS, ...THEMA_KINDS, 'controle-mislukt'];

/** De rij die bij een vondst hoort — wat `run.ts` er ook van maakt. */
const rij = rowForFinding;

const tmt: Finding = { kind: 'onbekend-label', label: 'TMT', trainingen: 7 };
const tmtGegroeid: Finding = { kind: 'onbekend-label', label: 'TMT', trainingen: 40 };
const yns: Finding = { kind: 'onbekend-label', label: 'YNS', trainingen: 10 };
const massages: Finding = {
  kind: 'thema-zonder-inhoud',
  themaId: '77',
  naam: 'Massages',
  trainingen: 2,
};

/** Een openstaande rij die exact past bij `finding` — er is dus niets aan veranderd. */
const open = (finding: Finding, itemId = 'i1'): ExistingSignal =>
  signal({ itemId, key: findingKey(finding), naam: rij(finding).naam });

/** Idem, maar afgevinkt; `door` zegt wie dat deed. */
const ticked = (finding: Finding, door: 'controle' | 'mens', itemId = 'i1'): ExistingSignal =>
  signal({
    itemId,
    key: findingKey(finding),
    naam: rij(finding).naam,
    afgehandeld: true,
    closedByCheck: door === 'controle',
    groupId: 'g_klaar',
  });

describe('reconcile — plaatsen', () => {
  it('plaatst een vondst die nog niet op het bord staat', () => {
    expect(reconcile({ rows: [rij(tmt)], existing: [], checked: ALL })).toEqual([
      { kind: 'create', row: rij(tmt) },
    ]);
  });

  it('plaatst niets als de melding al openstaat en er niets is veranderd', () => {
    expect(reconcile({ rows: [rij(tmt)], existing: [open(tmt)], checked: ALL })).toEqual([]);
  });
});

describe('reconcile — bijwerken', () => {
  /**
   * De naam draagt het aantal trainingen. Blijft die op 7 staan terwijl het er 40 zijn, dan
   * liegt het bord over de omvang van het probleem.
   */
  it('werkt een openstaande melding bij als de cijfers zijn verschoven', () => {
    const bestaand = open(tmt);
    expect(reconcile({ rows: [rij(tmtGegroeid)], existing: [bestaand], checked: ALL })).toEqual([
      { kind: 'update', signal: bestaand, row: rij(tmtGegroeid) },
    ]);
  });

  it('werkt bij als er een veld bij is gekomen dat leeg staat', () => {
    const eerst: Finding = {
      kind: 'label-onvolledig',
      code: 'CC',
      velden: [{ veld: 'logo', reden: 'leeg' }],
      trainingen: 9,
    };
    const nu: Finding = {
      kind: 'label-onvolledig',
      code: 'CC',
      velden: [
        { veld: 'logo', reden: 'leeg' },
        { veld: 'kleur', reden: 'leeg' },
      ],
      trainingen: 9,
    };
    const acties = reconcile({ rows: [rij(nu)], existing: [open(eerst)], checked: ALL });
    expect(acties.map((a) => a.kind)).toEqual(['update']);
  });

  it('werkt een AFGEVINKTE melding niet bij — die staat er bewust stil bij', () => {
    expect(
      reconcile({ rows: [rij(tmtGegroeid)], existing: [ticked(tmt, 'mens')], checked: ALL })
    ).toEqual([]);
  });
});

describe('reconcile — heropenen', () => {
  /**
   * Het onderscheid waar de kolom `Afgehandeld door` voor bestaat. Wij vinkten af omdat het
   * probleem wég was; komt het terug, dan is dat nieuwe informatie.
   */
  it('heropent wat de controle zelf had afgevinkt', () => {
    const dicht = ticked(tmt, 'controle');
    expect(reconcile({ rows: [rij(tmt)], existing: [dicht], checked: ALL })).toEqual([
      { kind: 'reopen', signal: dicht, row: rij(tmt) },
    ]);
  });

  it('laat staan wat een MENS heeft weggezet, ook als het probleem er nog is', () => {
    // "Massages" krijgt nooit briefinginhoud. Dat is een besluit, geen open punt.
    expect(
      reconcile({ rows: [rij(massages)], existing: [ticked(massages, 'mens')], checked: ALL })
    ).toEqual([]);
  });

  it('heropent niet wat niet meer gevonden wordt', () => {
    expect(reconcile({ rows: [], existing: [ticked(tmt, 'controle')], checked: ALL })).toEqual([]);
  });
});

describe('reconcile — afvinken', () => {
  it('vinkt een openstaande melding af die niet meer gevonden wordt', () => {
    const bestaand = open(tmt, 'i9');
    expect(reconcile({ rows: [], existing: [bestaand], checked: ALL })).toEqual([
      { kind: 'resolve', signal: bestaand },
    ]);
  });

  it('vinkt een al afgevinkte melding niet nog eens af', () => {
    expect(reconcile({ rows: [], existing: [ticked(tmt, 'mens')], checked: ALL })).toEqual([]);
  });
});

describe('reconcile — bereik van een mislukte controle', () => {
  /**
   * De belangrijkste test van dit bestand. Een controle die afbreekt levert nul vondsten op.
   * Zonder `checked` leest dat als "alles opgelost" en wordt elke openstaande melding
   * afgevinkt — op precies het moment dat we het minst weten.
   */
  it('ruimt NIETS op binnen een controle die niet is geslaagd', () => {
    expect(
      reconcile({
        rows: [rij(massages)],
        existing: [open(tmt), open(massages, 'i2')],
        checked: THEMA_KINDS,
      })
    ).toEqual([]);
  });

  it('ruimt wél op binnen de controle die wel is geslaagd', () => {
    const thema = open(massages, 'b');
    expect(
      reconcile({ rows: [], existing: [open(tmt, 'a'), thema], checked: THEMA_KINDS })
    ).toEqual([{ kind: 'resolve', signal: thema }]);
  });
});

describe('reconcile — rijen die niet van ons zijn', () => {
  it('laat een rij zonder sleutel met rust', () => {
    expect(
      reconcile({
        rows: [],
        existing: [signal({ key: '' }), signal({ key: '   ' })],
        checked: ALL,
      })
    ).toEqual([]);
  });

  it('laat een sleutel met rust die we niet kennen', () => {
    expect(
      reconcile({ rows: [], existing: [signal({ key: 'iets-anders:42' })], checked: ALL })
    ).toEqual([]);
  });
});

describe('reconcile — weigeringen', () => {
  it('weigert twee vondsten met dezelfde sleutel', () => {
    expect(() => reconcile({ rows: [rij(tmt), rij(tmt)], existing: [], checked: ALL })).toThrow(
      /dezelfde sleutel/
    );
  });

  it('weigert een vondst waarvan de controle niet als geslaagd is gemeld', () => {
    expect(() => reconcile({ rows: [rij(tmt)], existing: [], checked: THEMA_KINDS })).toThrow(
      /niet als geslaagd/
    );
  });
});

describe('reconcile — meerdere acties in één run', () => {
  it('plaatst, werkt bij, heropent en ruimt op in één keer', () => {
    const oud = open(tmt, 'oud');
    const dicht = ticked(massages, 'controle', 'dicht');
    const weg = open(yns, 'weg');

    const acties = reconcile({
      rows: [rij(tmtGegroeid), rij(massages)],
      existing: [oud, dicht, weg],
      checked: ALL,
    });

    expect(acties).toEqual([
      { kind: 'update', signal: oud, row: rij(tmtGegroeid) },
      { kind: 'reopen', signal: dicht, row: rij(massages) },
      { kind: 'resolve', signal: weg },
    ]);
  });
});
