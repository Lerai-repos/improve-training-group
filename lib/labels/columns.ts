import type { ExpectedColumn } from '@lib/monday/board-config';
import type { LabelConfig } from './types';

/**
 * De kolom-ids op het Labels-bord.
 *
 * Ids, geen titels. Iedereen met bordtoegang mag een kolom hernoemen, en een configuratie die
 * op de titel matcht breekt daar stilletjes op — dezelfde reden als bij de agenda- en
 * Instellingen-kolommen.
 */
export const LABEL_COLUMNS = {
  volledigeNaam: 'itg_volledige_naam',
  kleur: 'itg_kleur',
  term: 'itg_term',
  rapportterm: 'itg_rapportterm',
  evaluatieformulier: 'itg_evalformulier',
  website: 'itg_website',
  inventarisatieformulier: 'itg_invformulier',
  logo: 'itg_logo',
  voorblad: 'itg_voorblad',
  achterblad: 'itg_achterblad',
} as const;

/** Wat een bord tot het Labels-bord maakt. De bestandskolommen horen erbij: zonder die geen merk. */
export const LABEL_EXPECTED_COLUMNS: readonly ExpectedColumn[] = [
  { id: LABEL_COLUMNS.volledigeNaam, type: 'text' },
  { id: LABEL_COLUMNS.kleur, type: 'text' },
  { id: LABEL_COLUMNS.term, type: 'text' },
  { id: LABEL_COLUMNS.rapportterm, type: 'text' },
  { id: LABEL_COLUMNS.evaluatieformulier, type: 'link' },
  { id: LABEL_COLUMNS.website, type: 'link' },
  { id: LABEL_COLUMNS.inventarisatieformulier, type: 'link' },
  { id: LABEL_COLUMNS.logo, type: 'file' },
  { id: LABEL_COLUMNS.voorblad, type: 'file' },
  { id: LABEL_COLUMNS.achterblad, type: 'file' },
];

export interface LabelColumnSpec {
  readonly id: string;
  readonly title: string;
  readonly type: string;
}

/** In aanmaakvolgorde, zodat het bord van links naar rechts leest zoals iemand het invult. */
export const LABEL_COLUMN_SPECS: readonly LabelColumnSpec[] = [
  { id: LABEL_COLUMNS.volledigeNaam, title: 'Volledige naam', type: 'text' },
  { id: LABEL_COLUMNS.kleur, title: 'Kleur', type: 'text' },
  { id: LABEL_COLUMNS.term, title: 'Term', type: 'text' },
  { id: LABEL_COLUMNS.rapportterm, title: 'Rapportterm', type: 'text' },
  { id: LABEL_COLUMNS.evaluatieformulier, title: 'Evaluatieformulier', type: 'link' },
  { id: LABEL_COLUMNS.website, title: 'Website', type: 'link' },
  { id: LABEL_COLUMNS.inventarisatieformulier, title: 'Inventarisatieformulier', type: 'link' },
  { id: LABEL_COLUMNS.logo, title: 'Logo', type: 'file' },
  { id: LABEL_COLUMNS.voorblad, title: 'Voorblad', type: 'file' },
  { id: LABEL_COLUMNS.achterblad, title: 'Achterblad', type: 'file' },
];

/**
 * De `column_values` waarmee een rij wordt aangemaakt.
 *
 * **Een lege link-kolom moet worden WEGGELATEN, niet als `{url:'',text:''}` gestuurd.** Monday
 * accepteert dat laatste en zet er een link neer die naar niets wijst: in de interface niet te
 * onderscheiden van een echte, en `text` komt terug als lege string in plaats van als
 * afwezige waarde. Weglaten laat de cel écht leeg.
 *
 * De bestandskolommen staan er niet in — een bestand gaat via `add_file_to_column`, niet via
 * `create_item`.
 */
export function seedColumnValues(label: LabelConfig): Record<string, unknown> {
  const values: Record<string, unknown> = {
    [LABEL_COLUMNS.volledigeNaam]: label.volledigeNaam,
    [LABEL_COLUMNS.kleur]: label.kleur,
    [LABEL_COLUMNS.term]: label.term,
    [LABEL_COLUMNS.rapportterm]: label.rapportterm,
  };
  const links: ReadonlyArray<readonly [string, string]> = [
    [LABEL_COLUMNS.evaluatieformulier, label.evaluatieformulier],
    [LABEL_COLUMNS.website, label.website],
    [LABEL_COLUMNS.inventarisatieformulier, label.inventarisatieformulier],
  ];
  for (const [id, url] of links) {
    if (url.trim() !== '') {
      values[id] = { url, text: url };
    }
  }
  return values;
}
