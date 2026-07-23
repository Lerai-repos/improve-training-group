import type { MondayKlant, MondayThema, MondayTrainer, MondayTraining } from '@lib/monday';
import type { KlantInsert, ThemaInsert, TrainerInsert, TrainingInsert } from '@lib/types/database';

const SOURCE = 'monday';

export function trainerToInsert(t: MondayTrainer): TrainerInsert {
  return {
    source_system: SOURCE,
    external_item_id: t.externalItemId,
    external_board_id: t.externalBoardId,
    naam: t.naam,
    adres: t.adres,
    email: t.email,
    telefoon: t.telefoon,
    rate_key: t.rateKey,
  };
}

export function themaToInsert(t: MondayThema): ThemaInsert {
  return {
    source_system: SOURCE,
    external_item_id: t.externalItemId,
    external_board_id: t.externalBoardId,
    thema: t.thema,
  };
}

export function klantToInsert(k: MondayKlant): KlantInsert {
  return {
    source_system: SOURCE,
    external_item_id: k.externalItemId,
    klantnaam: k.klantnaam,
  };
}

/**
 * PLANNING-ONLY training insert. Deliberately omits every `*_snapshot` column so
 * a planning upsert can never clobber imported evaluation data (ownership
 * contract). Evaluation snapshots are written separately by `updateEvaluationSnapshot`.
 */
export function trainingToPlanningInsert(t: MondayTraining): TrainingInsert {
  return {
    source_system: SOURCE,
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
  };
}
