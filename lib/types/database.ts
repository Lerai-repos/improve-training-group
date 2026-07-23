/**
 * DB type surface. `database.gen.ts` is generated (`supabase gen types`) and is
 * the canonical source of the DB shape — regenerate it, never hand-edit it.
 * Here we alias the generated Row/Insert/Update types so app code has stable,
 * short names. camelCase domain models + row mappers layer on top (per feature).
 */
import type { Database } from './database.gen';

export type { Database };

type Tables = Database['public']['Tables'];
export type Enums = Database['public']['Enums'];

export type Qualification = Enums['qualification'];

export type TrainerRow = Tables['trainers']['Row'];
export type TrainerInsert = Tables['trainers']['Insert'];
export type TrainerUpdate = Tables['trainers']['Update'];

export type ThemaRow = Tables['themas']['Row'];
export type ThemaInsert = Tables['themas']['Insert'];
export type ThemaUpdate = Tables['themas']['Update'];

export type KlantRow = Tables['klanten']['Row'];
export type KlantInsert = Tables['klanten']['Insert'];
export type KlantUpdate = Tables['klanten']['Update'];

export type TrainingRow = Tables['trainings']['Row'];
export type TrainingInsert = Tables['trainings']['Insert'];
export type TrainingUpdate = Tables['trainings']['Update'];

export type TrainingTrainerRow = Tables['training_trainers']['Row'];
export type TrainingThemaRow = Tables['training_themas']['Row'];
export type TrainingKlantRow = Tables['training_klanten']['Row'];

export type TrainerThemeQualificationRow = Tables['trainer_theme_qualifications']['Row'];
export type TrainerThemeQualificationInsert = Tables['trainer_theme_qualifications']['Insert'];

export type ConfigRow = Tables['config']['Row'];
export type ConfigInsert = Tables['config']['Insert'];

export type RateCardRow = Tables['rate_cards']['Row'];
export type RateCardInsert = Tables['rate_cards']['Insert'];

export type LabelConfigRow = Tables['label_config']['Row'];
export type LabelConfigInsert = Tables['label_config']['Insert'];
