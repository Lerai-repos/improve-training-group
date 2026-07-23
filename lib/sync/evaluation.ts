import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@lib/types/database';

type Admin = SupabaseClient<Database>;

/** Imported evaluation aggregate for one training (from Google Sheets, M3). */
export interface EvaluationSnapshotInput {
  avgOverallGrade: number | null;
  evaluationCount: number | null;
  avgProgramContent?: number | null;
  avgPracticalWork?: number | null;
  avgConcreteTools?: number | null;
  avgTrainerCompetence?: number | null;
  avgTrainerCommunications?: number | null;
  revision?: string | null;
  importedAt?: string;
}

/**
 * Write ONLY the evaluation snapshot columns for a training, matched by external
 * identity. The other half of the ownership contract: this never touches a
 * planning column, so importing evaluations can't clobber Monday-sourced data.
 */
export async function updateEvaluationSnapshot(
  admin: Admin,
  externalItemId: string,
  snapshot: EvaluationSnapshotInput,
  sourceSystem = 'monday'
): Promise<void> {
  const { data, error } = await admin
    .from('trainings')
    .update({
      avg_overall_grade_snapshot: snapshot.avgOverallGrade,
      evaluation_count_snapshot: snapshot.evaluationCount,
      avg_program_content_snapshot: snapshot.avgProgramContent ?? null,
      avg_practical_work_snapshot: snapshot.avgPracticalWork ?? null,
      avg_concrete_tools_snapshot: snapshot.avgConcreteTools ?? null,
      avg_trainer_competence_snapshot: snapshot.avgTrainerCompetence ?? null,
      avg_trainer_communications_snapshot: snapshot.avgTrainerCommunications ?? null,
      evaluation_snapshot_imported_at: snapshot.importedAt ?? new Date().toISOString(),
      evaluation_snapshot_revision: snapshot.revision ?? null,
    })
    .eq('source_system', sourceSystem)
    .eq('external_item_id', externalItemId)
    .select('id');

  if (error) {
    throw new Error(`updateEvaluationSnapshot: ${error.message}`);
  }
  // A zero-row update is "successful" in Postgres — but it means the evaluation
  // arrived before its training (or a bad external id), and would be silently
  // lost. Surface it instead of discarding data (fase-1 clobber-bug class).
  if (!data || data.length === 0) {
    throw new Error(
      `updateEvaluationSnapshot: no training matched ${sourceSystem}:${externalItemId}`
    );
  }
}
