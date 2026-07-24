import type { SupabaseClient } from '@supabase/supabase-js';

import {
  EMPTY_ACK,
  validateSnapshot,
  type Acknowledgements,
  type MondayBoardScope,
  type MondayReadPort,
  type Page,
} from '@lib/monday';
import type { Database } from '@lib/types/database';

import { applyArtifact } from './apply';
import { buildArtifact } from './artifact';

type Admin = SupabaseClient<Database>;

export interface PlanningSyncResult {
  runId: string;
  trainers: number;
  themas: number;
  klanten: number;
  trainings: number;
  trainingTrainers: number;
  trainingThemas: number;
  trainingKlanten: number;
  qualObservations: number;
  qualEffective: number;
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

/**
 * Sync the planning side from a {@link MondayReadPort} into the DB.
 *
 * Reads the full board, **validates** it ({@link validateSnapshot} — fail-closed:
 * a fatal anomaly throws BEFORE any write), derives klanten from the Bedrijf
 * mirror (companyName), builds the immutable artifact, and applies it via the
 * single atomic RPC. Klant is derived from companyName so this is safe with ANY
 * read port (a port that returns no klanten can't silently wipe them). Writes
 * ONLY planning columns; evaluation snapshots are untouched.
 */
export async function syncPlanningFromMonday(
  admin: Admin,
  monday: MondayReadPort,
  scope: MondayBoardScope,
  ack: Acknowledgements = EMPTY_ACK
): Promise<PlanningSyncResult> {
  const [trainers, themas, trainings, qualifications] = await Promise.all([
    collectAll((s) => monday.getTrainers(s), scope),
    collectAll((s) => monday.getThemas(s), scope),
    collectAll((s) => monday.getTrainings(s), scope),
    monday.getQualifications(scope),
  ]);

  const validation = validateSnapshot({
    trainers,
    themas,
    trainings,
    qualifications,
    diagnostics: [],
    ack,
  });
  if (validation.fatalCount > 0) {
    const kinds = validation.anomalies
      .filter((a) => a.severity === 'fatal')
      .map((a) => a.kind)
      .join(', ');
    throw new Error(`sync validation failed (fatal): ${kinds}`);
  }

  // Inject the derived klant links into the trainings before building the artifact.
  const klantByTraining = new Map<string, string[]>();
  for (const link of validation.trainingKlant) {
    klantByTraining.set(link.trainingExt, [
      ...(klantByTraining.get(link.trainingExt) ?? []),
      link.klantExt,
    ]);
  }
  const trainingsWithKlant = trainings.map((t) => ({
    ...t,
    klantExternalIds: klantByTraining.get(t.externalItemId) ?? [],
  }));

  const artifact = buildArtifact({
    boardId: scope.boardId,
    trainers,
    themas,
    klanten: validation.klanten,
    trainings: trainingsWithKlant,
    qualifications,
    conflictOverrides: validation.conflictOverrides,
  });

  const { runId } = await applyArtifact(admin, artifact, { anomalies: validation.anomalies });

  return {
    runId,
    trainers: artifact.counts.trainers,
    themas: artifact.counts.themas,
    klanten: artifact.counts.klanten,
    trainings: artifact.counts.trainings,
    trainingTrainers: artifact.counts.training_trainers,
    trainingThemas: artifact.counts.training_themas,
    trainingKlanten: artifact.counts.training_klanten,
    qualObservations: artifact.counts.qual_observations,
    qualEffective: artifact.counts.qual_effective,
  };
}
