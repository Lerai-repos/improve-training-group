import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../decode';
import type { MondayThema, MondayTrainer, MondayTraining, MondayQualification } from '../types';
import {
  EMPTY_ACK,
  parseAcknowledgements,
  validateSnapshot,
  type Acknowledgements,
} from '../validate';

const trainer = (id: string, group: string | null = 'topics'): MondayTrainer => ({
  externalItemId: id,
  externalBoardId: '1661151090',
  naam: `T${id}`,
  adres: null,
  email: null,
  telefoon: null,
  mondayGroup: group,
  rateKey: null,
});
const thema = (id: string): MondayThema => ({
  externalItemId: id,
  externalBoardId: '5067928440',
  thema: `Th${id}`,
});
const training = (id: string, over: Partial<MondayTraining> = {}): MondayTraining => ({
  externalItemId: id,
  externalBoardId: '5087396949',
  externalGroupId: null,
  datum: null,
  tijd: null,
  taal: null,
  duurTraining: null,
  status: null,
  ieCode: null,
  omzetCents: null,
  locatie: null,
  label: null,
  companyName: 'Acme BV',
  trainerExternalIds: [],
  themaExternalIds: [],
  klantExternalIds: [],
  ...over,
});

const base = {
  trainers: [trainer('t1')],
  themas: [thema('th1')],
  trainings: [training('tr1', { trainerExternalIds: ['t1'], themaExternalIds: ['th1'] })],
  qualifications: [] as MondayQualification[],
  diagnostics: [] as Diagnostic[],
  ack: EMPTY_ACK,
};

describe('validateSnapshot', () => {
  it('passes a clean snapshot with an empty relation allowed', () => {
    const r = validateSnapshot({
      ...base,
      trainings: [training('tr1'), training('tr2', { trainerExternalIds: ['t1'] })],
    });
    expect(r.fatalCount).toBe(0);
    expect(r.klanten).toHaveLength(1);
  });

  it('is fatal on an unresolved trainer ref', () => {
    const r = validateSnapshot({
      ...base,
      trainings: [training('tr1', { trainerExternalIds: ['ghost'] })],
    });
    expect(r.fatalCount).toBeGreaterThan(0);
    expect(r.anomalies.some((a) => a.kind === 'unresolved_trainer_ref')).toBe(true);
  });

  it('is fatal on a malformed number diagnostic', () => {
    const diagnostics: Diagnostic[] = [
      { itemId: 'tr1', field: 'omzet', kind: 'malformed_number', raw: 'n/a' },
    ];
    const r = validateSnapshot({ ...base, diagnostics });
    expect(r.anomalies.some((a) => a.kind === 'malformed_value')).toBe(true);
    expect(r.fatalCount).toBeGreaterThan(0);
  });

  it('is fatal on an empty required field (blank trainer/theme name)', () => {
    const diagnostics: Diagnostic[] = [
      { itemId: 't9', field: 'naam', kind: 'empty_required', raw: '' },
    ];
    const r = validateSnapshot({ ...base, diagnostics });
    expect(r.anomalies.some((a) => a.kind === 'empty_required')).toBe(true);
    expect(r.fatalCount).toBeGreaterThan(0);
  });

  it('flags a no-Bedrijf training as allowed (klant unset), and names it when acked', () => {
    const trainings = [training('tr1', { companyName: null, trainerExternalIds: ['t1'] })];
    const dirty = validateSnapshot({ ...base, trainings });
    const anomaly = dirty.anomalies.find((a) => a.kind === 'no_bedrijf_klant');
    expect(anomaly?.severity).toBe('allowed');
    expect(dirty.fatalCount).toBe(0);
    expect(dirty.trainingKlant).toHaveLength(0); // imported with klant unset, not guessed

    const ack: Acknowledgements = { ...EMPTY_ACK, noBedrijfKlant: { tr1: 'Rechtbank Den Haag' } };
    const named = validateSnapshot({ ...base, trainings, ack });
    expect(named.fatalCount).toBe(0);
    expect(named.klanten.map((k) => k.klantnaam)).toContain('Rechtbank Den Haag');
  });

  it('re-escalates no-Bedrijf to fatal when the unlinked count spikes past the ceiling', () => {
    const trainings = Array.from({ length: 30 }, (_, i) =>
      training(`x${i}`, { companyName: null })
    );
    const r = validateSnapshot({ ...base, trainings });
    const anomaly = r.anomalies.find((a) => a.kind === 'no_bedrijf_klant');
    expect(anomaly?.severity).toBe('fatal');
    expect(r.fatalCount).toBeGreaterThan(0);
  });

  it('flags an alias candidate fatal, and merges on an explicit decision', () => {
    const trainings = [
      training('tr1', { companyName: 'De Heus' }),
      training('tr2', { companyName: 'De Heus (copy)' }),
    ];
    const dirty = validateSnapshot({ ...base, trainings });
    expect(dirty.anomalies.some((a) => a.kind === 'klant_alias_undecided')).toBe(true);

    const ack: Acknowledgements = {
      ...EMPTY_ACK,
      klantAliases: { 'de heus': { decision: 'merge', canonical: 'De Heus' } },
    };
    const merged = validateSnapshot({ ...base, trainings, ack });
    expect(merged.fatalCount).toBe(0);
    expect(merged.klanten).toHaveLength(1);
    expect(merged.trainingKlant.every((l) => l.klantExt === 'De Heus')).toBe(true);
  });

  it('flags an unmapped group as allowed (trainer still imported); acked adds provenance', () => {
    const dirty = validateSnapshot({ ...base, trainers: [trainer('t1', 'nieuwe_groep22164__1')] });
    expect(dirty.fatalCount).toBe(0);
    expect(
      dirty.anomalies.some((a) => a.kind === 'unmapped_group' && a.severity === 'allowed')
    ).toBe(true);

    const ack: Acknowledgements = { ...EMPTY_ACK, acknowledgedGroups: ['nieuwe_groep22164__1'] };
    const clean = validateSnapshot({
      ...base,
      trainers: [trainer('t1', 'nieuwe_groep22164__1')],
      ack,
    });
    expect(clean.fatalCount).toBe(0);
    expect(
      clean.anomalies.some(
        (a) => a.kind === 'acknowledged_unmapped_group' && a.severity === 'allowed'
      )
    ).toBe(true);
  });

  it('is fatal on a qualification referencing an absent trainer/thema', () => {
    const qualifications: MondayQualification[] = [
      { trainerExternalId: 'ghost', themaExternalId: 'th1', qualification: 'groen' },
    ];
    const r = validateSnapshot({ ...base, qualifications });
    expect(r.anomalies.some((a) => a.kind === 'unresolved_qual_ref')).toBe(true);
    expect(r.fatalCount).toBeGreaterThan(0);
  });

  it('parseAcknowledgements enforces types + rejects unknown keys (strict)', () => {
    // allowSourceDrop is a run-specific {board: number}, not a boolean/string.
    expect(() => parseAcknowledgements({ allowSourceDrop: 'false' })).toThrow();
    expect(() => parseAcknowledgements({ allowSourceDrop: true })).toThrow();
    expect(() => parseAcknowledgements({ klantAliases: { x: { decision: 'nope' } } })).toThrow();
    expect(() => parseAcknowledgements({ unknownKey: 1 })).toThrow();
    // allowSourceDrop entries are {from,to} transitions, not bare numbers.
    expect(() => parseAcknowledgements({ allowSourceDrop: { agenda: 5 } })).toThrow();
    // qualConflicts are colour-bound: bare strings are rejected.
    expect(() => parseAcknowledgements({ qualConflicts: { 'a::b': 'green' } })).toThrow();
    const ok = parseAcknowledgements({
      allowSourceDrop: { agenda: { from: 720, to: 5 } },
      allowNoBaseline: { agenda: 756 },
      qualConflicts: { 'a::b': { colours: ['groen', 'rood'], effective: 'green' } },
    });
    expect(ok.allowSourceDrop).toEqual({ agenda: { from: 720, to: 5 } });
    expect(ok.qualConflicts['a::b'].effective).toBe('green');
  });

  it('leaves an unresolved conflict allowed (effective NULL); resolves on a matching colour set', () => {
    const qualifications: MondayQualification[] = [
      { trainerExternalId: 't1', themaExternalId: 'th1', qualification: 'groen' },
      { trainerExternalId: 't1', themaExternalId: 'th1', qualification: 'rood' },
    ];
    const dirty = validateSnapshot({ ...base, qualifications });
    const anomaly = dirty.anomalies.find((a) => a.kind === 'qual_conflict_undecided');
    expect(anomaly?.severity).toBe('allowed');
    expect(dirty.fatalCount).toBe(0);
    expect(dirty.conflictOverrides['t1::th1']).toBeUndefined();

    // Wrong colour set (groen+oranje ≠ observed groen+rood) → still no override (effective NULL).
    const stale: Acknowledgements = {
      ...EMPTY_ACK,
      qualConflicts: { 't1::th1': { colours: ['groen', 'oranje'], effective: 'green' } },
    };
    const staleR = validateSnapshot({ ...base, qualifications, ack: stale });
    expect(staleR.fatalCount).toBe(0);
    expect(staleR.conflictOverrides['t1::th1']).toBeUndefined();

    // Matching colour set → resolved.
    const ack: Acknowledgements = {
      ...EMPTY_ACK,
      qualConflicts: { 't1::th1': { colours: ['rood', 'groen'], effective: 'green' } },
    };
    const clean = validateSnapshot({ ...base, qualifications, ack });
    expect(clean.fatalCount).toBe(0);
    expect(clean.conflictOverrides['t1::th1']).toBe('green');
  });

  it('re-escalates colour conflicts to fatal when they spike past the ceiling', () => {
    const n = 30;
    const trainers = Array.from({ length: n }, (_, i) => trainer(`t${i}`));
    const themas = Array.from({ length: n }, (_, i) => thema(`th${i}`));
    const makePair = (i: number): MondayQualification[] => [
      { trainerExternalId: `t${i}`, themaExternalId: `th${i}`, qualification: 'groen' },
      { trainerExternalId: `t${i}`, themaExternalId: `th${i}`, qualification: 'rood' },
    ];
    const qualifications = Array.from({ length: n }, (_, i) => i).flatMap(makePair);
    const r = validateSnapshot({ ...base, trainers, themas, qualifications, trainings: [] });
    const anomaly = r.anomalies.find((a) => a.kind === 'qual_conflict_undecided');
    expect(anomaly?.severity).toBe('fatal');
    expect(r.fatalCount).toBeGreaterThan(0);
  });
});
