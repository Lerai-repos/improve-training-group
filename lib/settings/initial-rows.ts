/**
 * What a COMPLETE Instellingen board contains.
 *
 * This lives in `lib` rather than in `instellingen-create.ts` for one reason: it is the
 * other half of a contract whose first half is already here. `required.ts` says which
 * keys a board must have; this says which rows a freshly built board gets. Nothing
 * connects them, so they can drift — add a key to `REQUIRED_APP_KEYS` without adding a
 * row here and every board the creator makes is born incomplete.
 *
 * That is not hypothetical: the creator calls `buildSettingsSnapshot` directly rather
 * than going through the loaders, so it is the one caller that a change to the required
 * set does not automatically reach. With the definition here, a test can hold the two
 * sides against each other.
 *
 * Values are in EUROS. The reader converts — see `euros.ts` for why that crossing
 * happens in exactly one place.
 */

export interface InitialRow {
  name: string;
  categorie: string;
  waarde: string;
  omschrijving: string;
}

/** The `Categorie` status labels, in board order. `Notitie` marks the escape hatch. */
export const CATEGORIES: readonly string[] = [
  'Algemeen',
  'Uurtarieven',
  'Reistarieven',
  'Trainergroepen',
  'Notitie',
];

/** The seven value rows, in board order. `TRAINERGROEPEN` is added by provisioning. */
export const INITIAL_ROWS: readonly InitialRow[] = [
  {
    name: 'HQ ADRES',
    categorie: 'Algemeen',
    waarde: 'Wolvenplein 25, Utrecht',
    omschrijving: 'Vertrekpunt voor de reiskosten die aan de klant worden gerekend.',
  },
  {
    name: 'REISTARIEF TRAINERS',
    categorie: 'Reistarieven',
    waarde: '0.23',
    omschrijving: 'Euro per kilometer die de trainer voor zijn reis krijgt.',
  },
  {
    name: 'REISTARIEF HQ',
    categorie: 'Reistarieven',
    waarde: '0.45',
    omschrijving: 'Euro per kilometer die aan de klant wordt gerekend, gerekend vanaf HQ.',
  },
  {
    name: 'REISTIJD DREMPEL',
    categorie: 'Reistarieven',
    waarde: '90',
    omschrijving: 'Minuten retour. Daaronder wordt geen reistijd vergoed.',
  },
  {
    name: 'REISTIJD VERGOEDING',
    categorie: 'Reistarieven',
    waarde: '1',
    omschrijving: 'Euro per minuut, alleen voor de minuten bóven de drempel.',
  },
  {
    name: 'TARIEF 2020 - 2024',
    categorie: 'Uurtarieven',
    waarde: '88',
    omschrijving: 'Uurtarief voor trainers die zijn ingestroomd tussen 2020 en 2024.',
  },
  {
    name: 'TARIEF 2024 - HEDEN',
    categorie: 'Uurtarieven',
    waarde: '84',
    omschrijving: 'Uurtarief voor trainers die zijn ingestroomd in 2024 of later.',
  },
];
