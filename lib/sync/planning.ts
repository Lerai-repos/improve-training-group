import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveQualification, type Qualification } from '@lib/calc';
import type { MondayBoardScope, MondayPort, Page } from '@lib/monday';
import type { Database } from '@lib/types/database';

import { klantToInsert, themaToInsert, trainerToInsert, trainingToPlanningInsert } from './mappers';

type Admin = SupabaseClient<Database>;

export interface PlanningSyncResult {
  trainers: number;
  themas: number;
  klanten: number;
  trainings: number;
  trainingTrainers: number;
  trainingThemas: number;
  trainingKlanten: number;
  qualifications: number;
}

/** Follow the cursor until a port has returned every page. */
async function collectAll<T>(
  fetchPage: (scope: MondayBoardScope) => Promise<Page<T>>,
  scope: MondayBoardScope
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = scope.cursor ?? null;
  for (;;) {
    const page = await fetchPage({ ...scope, cursor });
    all.push(...page.items);
    if (!page.nextCursor) {
      return all;
    }
    cursor = page.nextCursor;
  }
}

function toIdMap(
  rows: Array<{ id: string; external_item_id: string | null }> | null
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows ?? []) {
    if (row.external_item_id) {
      map.set(row.external_item_id, row.id);
    }
  }
  return map;
}

/** Turn an upsert result into an externalItemId → internal-uuid map. */
function resultToIdMap(
  data: Array<{ id: string; external_item_id: string | null }> | null,
  error: { message: string } | null,
  label: string
): Map<string, string> {
  if (error) {
    throw new Error(`sync ${label}: ${error.message}`);
  }
  return toIdMap(data);
}

const ID_QUERY_CHUNK = 200;

/**
 * Dedupe insert rows by external identity, keeping the last occurrence. A
 * duplicate (source_system, external_item_id) in one upsert batch would abort it
 * ("ON CONFLICT DO UPDATE command cannot affect row a second time").
 */
function dedupeByExternalId<T extends { external_item_id?: string | null }>(rows: T[]): T[] {
  const byId = new Map<string, T>();
  const withoutId: T[] = [];
  for (const row of rows) {
    if (row.external_item_id) {
      byId.set(row.external_item_id, row);
    } else {
      withoutId.push(row);
    }
  }
  return [...withoutId, ...byId.values()];
}

/**
 * Extend an externalItemId → uuid map with masters that already exist in the DB
 * but weren't in THIS sync batch, so a training linking to a previously-synced
 * master resolves instead of being silently dropped (and reconciled away).
 */
async function resolveReferencedIds(
  known: Map<string, string>,
  referenced: string[],
  fetch: (extIds: string[]) => PromiseLike<{
    data: Array<{ id: string; external_item_id: string | null }> | null;
    error: { message: string } | null;
  }>
): Promise<Map<string, string>> {
  const missing = [...new Set(referenced)].filter((id) => !known.has(id));
  if (missing.length === 0) {
    return known;
  }
  const merged = new Map(known);
  for (let i = 0; i < missing.length; i += ID_QUERY_CHUNK) {
    const { data, error } = await fetch(missing.slice(i, i + ID_QUERY_CHUNK));
    if (error) {
      throw new Error(`resolve referenced ids: ${error.message}`);
    }
    for (const row of data ?? []) {
      if (row.external_item_id) {
        merged.set(row.external_item_id, row.id);
      }
    }
  }
  return merged;
}

/**
 * Sync the planning side (masters, trainings, relations, qualifications) from a
 * {@link MondayPort} into the DB. Idempotent: re-running upserts on external
 * identity, so no duplicates. Writes ONLY planning columns — evaluation
 * snapshots are never touched here.
 */
export async function syncPlanningFromMonday(
  admin: Admin,
  monday: MondayPort,
  scope: MondayBoardScope
): Promise<PlanningSyncResult> {
  // TODO (#2, connection phase): one `scope` (boardId) is applied to all four
  // reads, but trainers/themas/trainings live on DIFFERENT boards, and clients
  // aren't a board at all (they come via the Opportunities mirror). The mock
  // ignores scope so tests pass, but the real GraphQL port needs per-entity
  // board resolution — settle the board/klant model when wiring the real port.
  const [trainers, themas, klanten, trainings, qualifications] = await Promise.all([
    collectAll((s) => monday.getTrainers(s), scope),
    collectAll((s) => monday.getThemas(s), scope),
    collectAll((s) => monday.getKlanten(s), scope),
    collectAll((s) => monday.getTrainings(s), scope),
    monday.getQualifications(scope),
  ]);

  let trainerIds = new Map<string, string>();
  const trainerRows = dedupeByExternalId(trainers.map(trainerToInsert));
  if (trainerRows.length > 0) {
    const { data, error } = await admin
      .from('trainers')
      .upsert(trainerRows, { onConflict: 'source_system,external_item_id' })
      .select('id, external_item_id');
    trainerIds = resultToIdMap(data, error, 'trainers');
  }

  let themaIds = new Map<string, string>();
  const themaRows = dedupeByExternalId(themas.map(themaToInsert));
  if (themaRows.length > 0) {
    const { data, error } = await admin
      .from('themas')
      .upsert(themaRows, { onConflict: 'source_system,external_item_id' })
      .select('id, external_item_id');
    themaIds = resultToIdMap(data, error, 'themas');
  }

  let klantIds = new Map<string, string>();
  const klantRows = dedupeByExternalId(klanten.map(klantToInsert));
  if (klantRows.length > 0) {
    const { data, error } = await admin
      .from('klanten')
      .upsert(klantRows, { onConflict: 'source_system,external_item_id' })
      .select('id, external_item_id');
    klantIds = resultToIdMap(data, error, 'klanten');
  }

  let trainingIds = new Map<string, string>();
  const trainingRows = dedupeByExternalId(trainings.map(trainingToPlanningInsert));
  if (trainingRows.length > 0) {
    const { data, error } = await admin
      .from('trainings')
      .upsert(trainingRows, { onConflict: 'source_system,external_item_id' })
      .select('id, external_item_id');
    trainingIds = resultToIdMap(data, error, 'trainings');
  }

  // Capture the AUTHORITATIVE trainer scope (trainers actually fetched this sync)
  // BEFORE the DB expansion below. Qualification reconcile must only touch these
  // trainers — expanding with looked-up trainers would delete the qualifications
  // of trainers that were merely referenced, not synced.
  const authoritativeTrainerIds = [...trainerIds.values()];

  // A training may link to a master synced in a PREVIOUS run (not in this batch).
  // Resolve those ids from the DB so the junction isn't dropped — and, because
  // relations are delete-then-insert reconciled, silently deleted (#3).
  trainerIds = await resolveReferencedIds(
    trainerIds,
    trainings.flatMap((t) => t.trainerExternalIds),
    (extIds) =>
      admin
        .from('trainers')
        .select('id, external_item_id')
        .eq('source_system', 'monday')
        .in('external_item_id', extIds)
  );
  themaIds = await resolveReferencedIds(
    themaIds,
    trainings.flatMap((t) => t.themaExternalIds),
    (extIds) =>
      admin
        .from('themas')
        .select('id, external_item_id')
        .eq('source_system', 'monday')
        .in('external_item_id', extIds)
  );
  klantIds = await resolveReferencedIds(
    klantIds,
    trainings.flatMap((t) => t.klantExternalIds),
    (extIds) =>
      admin
        .from('klanten')
        .select('id, external_item_id')
        .eq('source_system', 'monday')
        .in('external_item_id', extIds)
  );

  // Relations are RECONCILED, not just added: for every synced training we
  // replace its junction rows (delete-then-insert), so a trainer/theme/client
  // removed in the source is also removed here — including an emptied list.
  // TODO (connection phase): (a) delete-then-insert is not atomic (the JS client
  // has no transaction here), so a mid-sync failure can briefly leave a training's
  // relations incomplete until the next run; (b) the reconcile DELETE ... .in(
  // syncedTrainingIds) embeds every synced training UUID in one query string,
  // which won't scale to a full board (#6, URL/statement limits). Move this
  // reconcile into a Postgres function/RPC — one transaction, chunked/set-based —
  // which fixes both at once. (c) A referenced trainer/theme/client id absent
  // from BOTH this batch and the DB is currently filtered out silently; combined
  // with the delete-then-insert, an incomplete real-Monday master fetch could
  // remove a still-valid relation. Decide the policy when wiring the real port —
  // fail the sync, or skip that training's reconcile — rather than dropping links.
  const syncedTrainingIds = [...trainingIds.values()];

  const trainingTrainers = trainings.flatMap((tr) => {
    const trainingId = trainingIds.get(tr.externalItemId);
    if (!trainingId) {
      return [];
    }
    return tr.trainerExternalIds
      .map((ext) => trainerIds.get(ext))
      .filter((id): id is string => Boolean(id))
      .map((trainer_id) => ({ training_id: trainingId, trainer_id }));
  });
  if (syncedTrainingIds.length > 0) {
    const del = await admin.from('training_trainers').delete().in('training_id', syncedTrainingIds);
    if (del.error) {
      throw new Error(`sync training_trainers (reconcile): ${del.error.message}`);
    }
  }
  if (trainingTrainers.length > 0) {
    const { error } = await admin.from('training_trainers').insert(trainingTrainers);
    if (error) {
      throw new Error(`sync training_trainers: ${error.message}`);
    }
  }

  const trainingThemas = trainings.flatMap((tr) => {
    const trainingId = trainingIds.get(tr.externalItemId);
    if (!trainingId) {
      return [];
    }
    return tr.themaExternalIds
      .map((ext) => themaIds.get(ext))
      .filter((id): id is string => Boolean(id))
      .map((thema_id) => ({ training_id: trainingId, thema_id }));
  });
  if (syncedTrainingIds.length > 0) {
    const del = await admin.from('training_themas').delete().in('training_id', syncedTrainingIds);
    if (del.error) {
      throw new Error(`sync training_themas (reconcile): ${del.error.message}`);
    }
  }
  if (trainingThemas.length > 0) {
    const { error } = await admin.from('training_themas').insert(trainingThemas);
    if (error) {
      throw new Error(`sync training_themas: ${error.message}`);
    }
  }

  const trainingKlanten = trainings.flatMap((tr) => {
    const trainingId = trainingIds.get(tr.externalItemId);
    if (!trainingId) {
      return [];
    }
    return tr.klantExternalIds
      .map((ext) => klantIds.get(ext))
      .filter((id): id is string => Boolean(id))
      .map((klant_id) => ({ training_id: trainingId, klant_id }));
  });
  if (syncedTrainingIds.length > 0) {
    const del = await admin.from('training_klanten').delete().in('training_id', syncedTrainingIds);
    if (del.error) {
      throw new Error(`sync training_klanten (reconcile): ${del.error.message}`);
    }
  }
  if (trainingKlanten.length > 0) {
    const { error } = await admin.from('training_klanten').insert(trainingKlanten);
    if (error) {
      throw new Error(`sync training_klanten: ${error.message}`);
    }
  }

  // Collapse duplicate (trainer, theme) pairs from malformed source data via the
  // groen > oranje > rood > grijs precedence BEFORE upserting — otherwise a batch
  // with duplicate conflict keys is rejected by Postgres.
  const qualByPair = new Map<
    string,
    { trainerExt: string; themaExt: string; quals: Qualification[] }
  >();
  for (const q of qualifications) {
    const key = `${q.trainerExternalId}::${q.themaExternalId}`;
    const existing = qualByPair.get(key);
    qualByPair.set(key, {
      trainerExt: q.trainerExternalId,
      themaExt: q.themaExternalId,
      quals: existing ? [...existing.quals, q.qualification] : [q.qualification],
    });
  }
  // Qualifications are reconciled ONLY for trainers actually synced this run (the
  // authoritative scope) — the delete AND the insert use the same set. A trainer
  // merely looked up for a junction is out of scope: we neither remove nor
  // (re)insert its quals, so a training-only sync can't wipe them, and the insert
  // can't collide on the unique (trainer_id, thema_id) with an existing pair.
  const authoritativeTrainerIdSet = new Set(authoritativeTrainerIds);
  const qualRows = [...qualByPair.values()].flatMap((pair) => {
    const trainer_id = trainerIds.get(pair.trainerExt);
    const thema_id = themaIds.get(pair.themaExt);
    const qualification = resolveQualification(pair.quals);
    if (!trainer_id || !thema_id || !qualification) {
      return [];
    }
    if (!authoritativeTrainerIdSet.has(trainer_id)) {
      return [];
    }
    return [{ trainer_id, thema_id, qualification }];
  });
  if (authoritativeTrainerIds.length > 0) {
    const del = await admin
      .from('trainer_theme_qualifications')
      .delete()
      .in('trainer_id', authoritativeTrainerIds);
    if (del.error) {
      throw new Error(`sync qualifications (reconcile): ${del.error.message}`);
    }
  }
  if (qualRows.length > 0) {
    const { error } = await admin.from('trainer_theme_qualifications').insert(qualRows);
    if (error) {
      throw new Error(`sync trainer_theme_qualifications: ${error.message}`);
    }
  }

  return {
    trainers: trainerIds.size,
    themas: themaIds.size,
    klanten: klantIds.size,
    trainings: trainingIds.size,
    trainingTrainers: trainingTrainers.length,
    trainingThemas: trainingThemas.length,
    trainingKlanten: trainingKlanten.length,
    qualifications: qualRows.length,
  };
}
