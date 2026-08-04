import { assessedColours, type Qualification } from '@lib/calc';
import type {
  MondayKlant,
  MondayQualification,
  MondayThema,
  MondayTrainer,
  MondayTraining,
} from '@lib/monday';

/**
 * Pure builder: decoded Monday domain objects → the immutable artifact the
 * atomic apply RPC consumes. All external-id based (the RPC resolves ids), and
 * deduped so no upsert/insert hits a duplicate conflict key. `counts` is derived
 * from the final arrays and re-verified inside the RPC (truncation guard).
 *
 * Qualifications are split: every (trainer, thema, colour) is an OBSERVATION;
 * the EFFECTIVE green/red value is derived per pair — only groen/rood auto-map,
 * oranje/grijs and conflicts leave effective null (see {@link deriveEffective}).
 */

const SCHEMA_VERSION = 1;

export type EffectiveQualification = 'green' | 'red';

export interface ArtifactTrainer {
  external_item_id: string;
  external_board_id: string;
  naam: string;
  adres: string | null;
  email: string | null;
  telefoon: string | null;
  monday_group: string | null;
  rate_key: string | null;
}
export interface ArtifactThema {
  external_item_id: string;
  external_board_id: string;
  thema: string;
}
export interface ArtifactKlant {
  external_item_id: string;
  klantnaam: string;
}
export interface ArtifactTraining {
  external_item_id: string;
  external_board_id: string;
  external_group_id: string | null;
  datum: string | null;
  tijd: string | null;
  taal: string | null;
  duur_training: number | null;
  status: string | null;
  ie_code: string | null;
  omzet_cents: number | null;
  locatie: string | null;
  label: string | null;
}
export interface ArtifactJunction {
  training_ext: string;
  trainer_ext?: string;
  thema_ext?: string;
  klant_ext?: string;
}
export interface ArtifactObservation {
  trainer_ext: string;
  thema_ext: string;
  colour: Qualification;
  source_column: string | null;
}
export interface ArtifactEffective {
  trainer_ext: string;
  thema_ext: string;
  effective: EffectiveQualification | null;
  conflict_resolution: { colours: Qualification[] } | null;
}

export interface MondaySnapshotArtifact {
  scope: { boardId: string };
  schemaVersion: number;
  counts: Record<string, number>;
  trainers: ArtifactTrainer[];
  themas: ArtifactThema[];
  klanten: ArtifactKlant[];
  trainings: ArtifactTraining[];
  training_trainers: ArtifactJunction[];
  training_themas: ArtifactJunction[];
  training_klanten: ArtifactJunction[];
  qual_observations: ArtifactObservation[];
  qual_effective: ArtifactEffective[];
}

export interface BuildArtifactInput {
  boardId: string;
  trainers: MondayTrainer[];
  themas: MondayThema[];
  klanten: MondayKlant[];
  trainings: MondayTraining[];
  qualifications: MondayQualification[];
  /**
   * Reviewed effective values for allowlisted colour conflicts, keyed
   * `trainerExt::themaExt`. Applied over the auto-derived effective, so a
   * conflict resolves to its confirmed green/red instead of null.
   */
  conflictOverrides?: Record<string, EffectiveQualification>;
}

/** Keep the last occurrence per external id (stable, avoids duplicate conflict keys). */
function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    byKey.set(key(row), row);
  }
  return [...byKey.values()];
}

/**
 * Derive the effective green/red value for a trainer×theme pair from its raw
 * colours. Only unambiguous groen→green / rood→red auto-map; oranje/grijs leave
 * effective null (mapping unconfirmed); a multi-colour conflict leaves effective
 * null and records the colours for the reviewed allowlist to resolve.
 */
export function deriveEffective(colours: readonly Qualification[]): {
  effective: EffectiveQualification | null;
  conflict_resolution: { colours: Qualification[] } | null;
} {
  // grijs is "not assessed", not a rival opinion — see assessedColours.
  const unique = assessedColours(colours);
  if (unique.length > 1) {
    return { effective: null, conflict_resolution: { colours: unique } };
  }
  const only = unique[0];
  if (only === 'groen') {
    return { effective: 'green', conflict_resolution: null };
  }
  if (only === 'rood') {
    return { effective: 'red', conflict_resolution: null };
  }
  return { effective: null, conflict_resolution: null };
}

export function buildArtifact(input: BuildArtifactInput): MondaySnapshotArtifact {
  const trainers: ArtifactTrainer[] = dedupeBy(
    input.trainers.map((t) => ({
      external_item_id: t.externalItemId,
      external_board_id: t.externalBoardId,
      naam: t.naam,
      adres: t.adres,
      email: t.email,
      telefoon: t.telefoon,
      monday_group: t.mondayGroup,
      rate_key: t.rateKey,
    })),
    (t) => t.external_item_id
  );

  const themas: ArtifactThema[] = dedupeBy(
    input.themas.map((t) => ({
      external_item_id: t.externalItemId,
      external_board_id: t.externalBoardId,
      thema: t.thema,
    })),
    (t) => t.external_item_id
  );

  const klanten: ArtifactKlant[] = dedupeBy(
    input.klanten.map((k) => ({ external_item_id: k.externalItemId, klantnaam: k.klantnaam })),
    (k) => k.external_item_id
  );

  const trainings: ArtifactTraining[] = dedupeBy(
    input.trainings.map((t) => ({
      external_item_id: t.externalItemId,
      external_board_id: t.externalBoardId,
      external_group_id: t.externalGroupId,
      datum: t.datum,
      tijd: t.tijd,
      taal: t.taal,
      duur_training: t.duurTraining,
      status: t.status,
      ie_code: t.ieCode,
      omzet_cents: t.omzetCents,
      locatie: t.locatie,
      label: t.label,
    })),
    (t) => t.external_item_id
  );

  const trainingTrainers: ArtifactJunction[] = dedupeBy(
    input.trainings.flatMap((tr) =>
      tr.trainerExternalIds.map((ext) => ({ training_ext: tr.externalItemId, trainer_ext: ext }))
    ),
    (j) => `${j.training_ext}::${j.trainer_ext}`
  );
  const trainingThemas: ArtifactJunction[] = dedupeBy(
    input.trainings.flatMap((tr) =>
      tr.themaExternalIds.map((ext) => ({ training_ext: tr.externalItemId, thema_ext: ext }))
    ),
    (j) => `${j.training_ext}::${j.thema_ext}`
  );
  const trainingKlanten: ArtifactJunction[] = dedupeBy(
    input.trainings.flatMap((tr) =>
      tr.klantExternalIds.map((ext) => ({ training_ext: tr.externalItemId, klant_ext: ext }))
    ),
    (j) => `${j.training_ext}::${j.klant_ext}`
  );

  // Group raw colours per (trainer, thema).
  const byPair = new Map<string, { trainer: string; thema: string; colours: Qualification[] }>();
  for (const q of input.qualifications) {
    const key = `${q.trainerExternalId}::${q.themaExternalId}`;
    const entry = byPair.get(key) ?? {
      trainer: q.trainerExternalId,
      thema: q.themaExternalId,
      colours: [],
    };
    entry.colours.push(q.qualification);
    byPair.set(key, entry);
  }

  const qualObservations: ArtifactObservation[] = dedupeBy(
    input.qualifications.map((q) => ({
      trainer_ext: q.trainerExternalId,
      thema_ext: q.themaExternalId,
      colour: q.qualification,
      source_column: q.sourceColumn ?? null,
    })),
    (o) => `${o.trainer_ext}::${o.thema_ext}::${o.colour}`
  );

  const overrides = input.conflictOverrides ?? {};
  const qualEffective: ArtifactEffective[] = [...byPair.values()].map((p) => {
    const derived = deriveEffective(p.colours);
    const override = overrides[`${p.trainer}::${p.thema}`];
    if (override && derived.effective === null) {
      return {
        trainer_ext: p.trainer,
        thema_ext: p.thema,
        effective: override,
        conflict_resolution: { colours: [...new Set(p.colours)] },
      };
    }
    return {
      trainer_ext: p.trainer,
      thema_ext: p.thema,
      effective: derived.effective,
      conflict_resolution: derived.conflict_resolution,
    };
  });

  const artifact: Omit<MondaySnapshotArtifact, 'counts'> = {
    scope: { boardId: input.boardId },
    schemaVersion: SCHEMA_VERSION,
    trainers,
    themas,
    klanten,
    trainings,
    training_trainers: trainingTrainers,
    training_themas: trainingThemas,
    training_klanten: trainingKlanten,
    qual_observations: qualObservations,
    qual_effective: qualEffective,
  };

  const counts: Record<string, number> = {
    trainers: trainers.length,
    themas: themas.length,
    klanten: klanten.length,
    trainings: trainings.length,
    training_trainers: trainingTrainers.length,
    training_themas: trainingThemas.length,
    training_klanten: trainingKlanten.length,
    qual_observations: qualObservations.length,
    qual_effective: qualEffective.length,
  };

  return { ...artifact, counts };
}
