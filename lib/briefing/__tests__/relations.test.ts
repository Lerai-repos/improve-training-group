import { describe, expect, it } from 'vitest';

import { AGENDA_2025_HISTORY, AGENDA_2026_HISTORY } from '@lib/evaluations';

import {
  AGENDA_2026_RELATIONS,
  BRIEFING_EXPECTED_COLUMNS,
  briefingItemFields,
  briefingExpectedColumns,
  briefingRelationsFor,
} from '../read';

/**
 * De briefing leest de relaties van het bord van de training. Gemeten 14-Sep-2026: op Agenda
 * 2025 ontbraken precies deze drie kolommen, en daarop weigerde de tab met "schema drift".
 */
describe('briefingExpectedColumns', () => {
  it('eist op 2026 precies wat altijd al geëist werd', () => {
    const ids = (cols: readonly { id: string }[]) => cols.map((c) => c.id).sort();
    expect(ids(briefingExpectedColumns(AGENDA_2026_RELATIONS))).toEqual(
      ids(BRIEFING_EXPECTED_COLUMNS)
    );
  });

  it('eist op 2025 de relaties van 2025, en geen co-trainerkolom', () => {
    const ids = briefingExpectedColumns(briefingRelationsFor(AGENDA_2025_HISTORY)).map((c) => c.id);
    expect(ids).toContain('board_relation_mkz4w78');
    expect(ids).toContain('board_relation_mkz4hjnt');
    expect(ids).not.toContain('itg_cotrainers');
    expect(ids).not.toContain('board_relation_mkz4y7tb');
  });

  it('neemt de co-trainerkolom mee waar het bord hem heeft', () => {
    expect(briefingRelationsFor(AGENDA_2026_HISTORY).coTrainer).toBe('itg_cotrainers');
  });
});

describe('briefingItemFields', () => {
  /** Monday geeft alleen gevraagde kolommen terug; anders wierp de lezer op 2025. */
  it('vraagt de relaties van het bord zelf op', () => {
    const fields = briefingItemFields(briefingRelationsFor(AGENDA_2025_HISTORY));
    expect(fields).toContain('board_relation_mkz4hjnt');
    expect(fields).toContain('board_relation_mkz4w78');
  });
});
