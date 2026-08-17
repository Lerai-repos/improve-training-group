import { describe, expect, it } from 'vitest';

import { assertSchemasAgree, buildCopyPayload, diffCells } from '../copy-item';

import type { SchemaColumn, SourceCell } from '../copy-item';

const text = (id: string, value: string): SourceCell => ({ id, type: 'text', value });

describe('buildCopyPayload', () => {
  it('copies an ordinary column verbatim', () => {
    const { values } = buildCopyPayload([text('tekst7', '"Braillelaan 9, Rijswijk"')]);

    expect(values).toEqual({ tekst7: 'Braillelaan 9, Rijswijk' });
  });

  /**
   * THE trap this module exists for. A populated relation reports `value: null`, so the
   * obvious "skip anything null" loop drops it — and the copy then looks complete
   * everywhere except in the answer it produces. An agenda item without its thema link
   * yields a legitimate GEEN MATCH, which reads as an engine bug.
   */
  it('copies a board relation from linked_item_ids, not from its null value', () => {
    const relation: SourceCell = {
      id: 'board_relation_mkz4920y',
      type: 'board_relation',
      value: null,
      linked_item_ids: ['5072549387'],
    };

    const { values } = buildCopyPayload([relation]);

    expect(values).toEqual({ board_relation_mkz4920y: { item_ids: [5072549387] } });
  });

  it('writes relations in the shape Monday accepts, not the one it returns', () => {
    const { values } = buildCopyPayload([
      { id: 'rel', type: 'board_relation', value: null, linked_item_ids: ['1', '2'] },
    ]);

    // `{item_ids:[…]}` on write; the API answers with `linkedPulseIds` — different shape.
    expect(values.rel).toEqual({ item_ids: [1, 2] });
    expect(JSON.stringify(values.rel)).not.toContain('linkedPulseId');
  });

  /**
   * ABSENT is not empty — and this is the original bug in a new hat. `linked_item_ids`
   * goes missing when the projection stops asking for the `BoardRelationValue` fragment;
   * coercing that to `[]` drops every link and reports a perfectly clean copy, which is
   * exactly how the thema link vanished the first time.
   */
  it('refuses a relation whose linked_item_ids were never requested', () => {
    const { values, unreadable } = buildCopyPayload([
      { id: 'rel', type: 'board_relation', value: null },
    ]);

    expect(unreadable).toEqual(['rel']);
    expect(values).toEqual({});
  });

  it('omits an empty relation rather than sending an empty list', () => {
    const { values } = buildCopyPayload([
      { id: 'rel', type: 'board_relation', value: null, linked_item_ids: [] },
    ]);

    expect(values).toEqual({});
  });

  it('skips columns Monday computes, and says so when they held something', () => {
    const { values, skipped } = buildCopyPayload([
      { id: 'button__1', type: 'button', value: '"Click me"' },
      { id: 'formula_1', type: 'formula', value: '"42"' },
      text('tekst', '"blijft"'),
    ]);

    expect(values).toEqual({ tekst: 'blijft' });
    expect(skipped.map((s) => s.columnId)).toEqual(['button__1', 'formula_1']);
  });

  /**
   * A stale verdict carried across would make a fresh test item look like it had already
   * been computed — the one thing a test fixture must not do.
   */
  it('honours an explicit skip list', () => {
    const { values, skipped } = buildCopyPayload(
      [{ id: 'color_mkzwfy42', type: 'status', value: '{"index":1}' }, text('tekst', '"x"')],
      { skipColumnIds: ['color_mkzwfy42'] }
    );

    expect(values).toEqual({ tekst: 'x' });
    expect(skipped[0]).toEqual({ columnId: 'color_mkzwfy42', reason: 'expliciet overgeslagen' });
  });

  it('omits an empty ordinary column without reporting it', () => {
    const { values, skipped } = buildCopyPayload([
      { id: 'leeg', type: 'text', value: null },
      { id: 'ook_leeg', type: 'text', value: 'null' },
    ]);

    expect(values).toEqual({});
    expect(skipped).toEqual([]);
  });

  /**
   * Kept apart from `skipped` on purpose. `skipped` is a list of decisions the caller can
   * print and move on from; this is a failure it must act on — writing a copy already
   * known to be incomplete leaves a half-built item somebody has to find and delete.
   */
  it('reports an unparseable value as unreadable, not as a skip', () => {
    const { values, skipped, unreadable } = buildCopyPayload([
      { id: 'raar', type: 'text', value: '{oops' },
      { id: 'button__1', type: 'button', value: '"Click me"' },
    ]);

    expect(values).toEqual({});
    expect(unreadable).toEqual(['raar']);
    // The button is a decision; the broken value is not.
    expect(skipped.map((s) => s.columnId)).toEqual(['button__1']);
  });

  it('reports nothing unreadable for a clean item', () => {
    expect(buildCopyPayload([text('tekst', '"x"')]).unreadable).toEqual([]);
  });
});

describe('diffCells', () => {
  const cell = (id: string, textValue: string): SourceCell => ({
    id,
    type: 'text',
    text: textValue,
    value: JSON.stringify(textValue),
  });
  const source: SourceCell[] = [
    cell('tekst7', 'Rijswijk'),
    { id: 'rel', type: 'board_relation', value: null, text: '', linked_item_ids: ['7'] },
    { id: 'button__1', type: 'button', text: 'Click me', value: '"Click me"' },
  ];

  it('sees nothing wrong with a faithful copy', () => {
    expect(diffCells(source, source)).toEqual([]);
  });

  /** The failure the first hand-rolled copy had, now detectable rather than mysterious. */
  it('reports a relation that did not make it across', () => {
    const copy: SourceCell[] = [
      cell('tekst7', 'Rijswijk'),
      { id: 'rel', type: 'board_relation', value: null, text: '', linked_item_ids: [] },
      { id: 'button__1', type: 'button', text: '', value: null },
    ];

    expect(diffCells(source, copy)).toEqual(['rel']);
  });

  /**
   * The false positive that made the first real run fail on a copy that was correct.
   * Monday stamps `override_all_ids` onto a dropdown it was TOLD to set, so the JSON
   * differs while the selection is identical. A check that fires on every correct copy
   * is worse than none — it trains you to ignore it.
   */
  it('does not report a dropdown whose JSON gained server metadata', () => {
    const before: SourceCell[] = [
      { id: 'dd', type: 'dropdown', text: 'Groeimindset', value: '{"ids":[19]}' },
    ];
    const after: SourceCell[] = [
      {
        id: 'dd',
        type: 'dropdown',
        text: 'Groeimindset',
        value: '{"ids":[19],"override_all_ids":"true"}',
      },
    ];

    expect(diffCells(before, after)).toEqual([]);
  });

  it('still reports a dropdown whose selection actually changed', () => {
    const before: SourceCell[] = [
      { id: 'dd', type: 'dropdown', text: 'Groeimindset', value: '{"ids":[19]}' },
    ];
    const after: SourceCell[] = [
      { id: 'dd', type: 'dropdown', text: 'Onderhandelen', value: '{"ids":[20]}' },
    ];

    expect(diffCells(before, after)).toEqual(['dd']);
  });

  it('ignores computed columns and anything deliberately skipped', () => {
    const copy: SourceCell[] = [
      cell('tekst7', 'Rijswijk'),
      { id: 'rel', type: 'board_relation', value: null, text: '', linked_item_ids: ['7'] },
      { id: 'button__1', type: 'button', text: '', value: null },
    ];

    expect(diffCells(source, copy)).toEqual([]);
    expect(diffCells(source, [copy[1], copy[2]], { skipColumnIds: ['tekst7'] })).toEqual([]);
  });

  /**
   * Same distinction on the read-back: a copy whose relations were never queried must
   * not compare equal to a source that genuinely links nothing, or the verification
   * approves a copy that lost every link.
   */
  it('does not let an unqueried relation pass as an empty one', () => {
    const withLinks: SourceCell[] = [
      { id: 'rel', type: 'board_relation', value: null, text: '', linked_item_ids: [] },
    ];
    const unqueried: SourceCell[] = [{ id: 'rel', type: 'board_relation', value: null, text: '' }];

    expect(diffCells(withLinks, unqueried)).toEqual(['rel']);
  });

  it('reports a column missing from the copy entirely', () => {
    expect(diffCells(source, [source[1]])).toEqual(['tekst7']);
  });
});

describe('assertSchemasAgree', () => {
  const board = (name: string, columns: SchemaColumn[]) => ({ name, columns });
  const rel = (id: string, boardIds: number[]): SchemaColumn => ({
    id,
    type: 'board_relation',
    settings_str: JSON.stringify({ boardIds }),
  });
  const agenda2026 = board('Agenda 2026', [
    { id: 'tekst7', type: 'text' },
    { id: 'datum_1', type: 'date' },
    rel('board_relation_mkz4920y', [1661151090]),
  ]);

  it('accepts a target with the same shape', () => {
    expect(() => assertSchemasAgree(agenda2026, board('TEST Agenda 2026', agenda2026.columns))).not
      .toThrow();
  });

  /**
   * The real 2025 → 2026 case. Those boards differ on exactly the thema relation
   * (`board_relation_mkz4hjnt` versus `board_relation_mkz4920y`), so the link would land
   * in a column the target does not have and the fixture would produce GEEN MATCH for
   * reasons nobody could see.
   */
  it('refuses a target missing a column the source has', () => {
    const target = board('TEST Agenda 2026', [{ id: 'tekst7', type: 'text' }]);

    expect(() => assertSchemasAgree(agenda2026, target)).toThrow(/board_relation_mkz4920y/);
  });

  /**
   * Checked over the SCHEMA, not the payload. A column that is empty on today's item
   * contributes no value, so a payload-driven check passes — and breaks on the next item
   * that has it filled.
   */
  it('refuses a missing column even when it is empty on the item being copied', () => {
    const target = board('TEST', [
      { id: 'tekst7', type: 'text' },
      rel('board_relation_mkz4920y', [1661151090]),
    ]);

    // `datum_1` carries no value here, yet the boards still do not match.
    expect(() => assertSchemasAgree(agenda2026, target)).toThrow(/datum_1/);
  });

  it('refuses a column that exists with a different type', () => {
    const target = board('TEST', [
      { id: 'tekst7', type: 'numbers' },
      { id: 'datum_1', type: 'date' },
      rel('board_relation_mkz4920y', [1661151090]),
    ]);

    expect(() => assertSchemasAgree(agenda2026, target)).toThrow(/tekst7.*numbers/s);
  });

  /**
   * Same id, same type, different board behind it — the write is accepted and the link
   * then means something else. Type equality alone cannot see this.
   */
  it('refuses a relation repointed at another board', () => {
    const target = board('TEST', [
      { id: 'tekst7', type: 'text' },
      { id: 'datum_1', type: 'date' },
      rel('board_relation_mkz4920y', [9999999999]),
    ]);

    expect(() => assertSchemasAgree(agenda2026, target)).toThrow(/verwijst naar/);
  });

  /**
   * Not copying a column's VALUE and not needing the column are different things. The
   * engine writes its verdict to the recommendation status column — skipped precisely so
   * a stale verdict does not travel — and reads the klant through a mirror, a computed
   * type. A target missing either yields a fixture the engine cannot process, so both
   * must still be required to exist.
   */
  it('requires columns whose values are deliberately not copied', () => {
    const source = board('Agenda 2026', [
      ...agenda2026.columns,
      {
        id: 'color_mkzwfy42',
        type: 'status',
        settings_str: JSON.stringify({ labels: { '1': 'GEREED' } }),
      },
      {
        id: 'lookup_mkszzfvr',
        type: 'mirror',
        settings_str: JSON.stringify({
          relation_column: { board_relation: true },
          displayed_linked_columns: { '1279052045': ['connect_boards31'] },
        }),
      },
    ]);

    expect(() => assertSchemasAgree(source, board('TEST', agenda2026.columns))).toThrow(
      /color_mkzwfy42/
    );
    expect(() => assertSchemasAgree(source, board('TEST', agenda2026.columns))).toThrow(
      /lookup_mkszzfvr/
    );
    expect(() => assertSchemasAgree(source, board('TEST', source.columns))).not.toThrow();
  });

  /**
   * Judged on each side INDEPENDENTLY. A shared sentinel compares equal to itself, so two
   * unreadable configurations used to agree with each other and pass a check whose whole
   * promise is to fail closed.
   */
  /**
   * The mirror is the dangerous one: `diffCells` skips computed types, so a re-sourced
   * klant is invisible to the read-back too. A fixture would be declared identical while
   * the engine reads the wrong company off it.
   */
  it('rejects a mirror re-sourced at another board', () => {
    const mirror = (boardId: string): SchemaColumn => ({
      id: 'lookup_mkszzfvr',
      type: 'mirror',
      settings_str: JSON.stringify({
        relation_column: { board_relation: true },
        displayed_linked_columns: { [boardId]: ['connect_boards31'] },
      }),
    });
    const src = board('Agenda 2026', [...agenda2026.columns, mirror('1279052045')]);
    const tgt = board('TEST', [...agenda2026.columns, mirror('9999999999')]);

    expect(() => assertSchemasAgree(src, tgt)).toThrow(/lookup_mkszzfvr/);
    expect(() => assertSchemasAgree(src, src)).not.toThrow();
  });

  /** We write `{ids:[19]}`; a different id map selects a different option entirely. */
  it('rejects a dropdown whose option ids were remapped', () => {
    const dd = (id: number): SchemaColumn => ({
      id: 'dropdown_mkmvk0y4',
      type: 'dropdown',
      settings_str: JSON.stringify({ labels: [{ id, name: 'Groeimindset' }] }),
    });

    expect(() =>
      assertSchemasAgree(
        board('bron', [...agenda2026.columns, dd(19)]),
        board('doel', [...agenda2026.columns, dd(21)])
      )
    ).toThrow(/dropdown_mkmvk0y4/);
  });

  /** Likewise `{index:1}` — a different label map means a different verdict. */
  it('rejects a status whose labels were remapped', () => {
    const st = (labels: Record<string, string>): SchemaColumn => ({
      id: 'color_mkzwfy42',
      type: 'status',
      settings_str: JSON.stringify({ labels }),
    });

    expect(() =>
      assertSchemasAgree(
        board('bron', [...agenda2026.columns, st({ '0': 'GEEN MATCH', '1': 'GEREED' })]),
        board('doel', [...agenda2026.columns, st({ '0': 'GEREED', '1': 'GEEN MATCH' })])
      )
    ).toThrow(/color_mkzwfy42/);
  });

  /**
   * Only the SEMANTIC keys are compared. Colours, positions and `hide_footer` differ for
   * cosmetic reasons, and blocking a copy over a label colour is how a check earns its
   * way onto somebody's ignore list.
   */
  it('ignores cosmetic settings that do not change what a value means', () => {
    const st = (colour: number): SchemaColumn => ({
      id: 'color_mkzwfy42',
      type: 'status',
      settings_str: JSON.stringify({
        labels: { '0': 'GEEN MATCH', '1': 'GEREED' },
        labels_colors: { '0': { color: colour } },
        labels_positions_v2: { '0': colour },
      }),
    });

    expect(() =>
      assertSchemasAgree(
        board('bron', [...agenda2026.columns, st(11)]),
        board('doel', [...agenda2026.columns, st(8)])
      )
    ).not.toThrow();
  });

  it('rejects unreadable relation settings on the target', () => {
    const broken: SchemaColumn = {
      id: 'board_relation_mkz4920y',
      type: 'board_relation',
      settings_str: '{oops',
    };
    const target = board('TEST', [
      { id: 'tekst7', type: 'text' },
      { id: 'datum_1', type: 'date' },
      broken,
    ]);

    expect(() => assertSchemasAgree(agenda2026, target)).toThrow(/doelbord.*niet te lezen/s);
  });

  it('rejects unreadable relation settings on the source too', () => {
    const brokenSource = board('Agenda 2026', [
      { id: 'tekst7', type: 'text' },
      { id: 'datum_1', type: 'date' },
      { id: 'board_relation_mkz4920y', type: 'board_relation', settings_str: '{oops' },
    ]);

    expect(() => assertSchemasAgree(brokenSource, agenda2026)).toThrow(/bron.*niet te lezen/s);
  });

  /** Both broken is the case a sentinel string quietly waved through. */
  it('rejects when BOTH sides are unreadable, rather than calling them equal', () => {
    const broken = (name: string) =>
      board(name, [
        { id: 'tekst7', type: 'text' },
        { id: 'datum_1', type: 'date' },
        { id: 'board_relation_mkz4920y', type: 'board_relation', settings_str: '{oops' },
      ]);

    expect(() => assertSchemasAgree(broken('bron'), broken('doel'))).toThrow();
  });

  /** Likewise two columns that both simply omit `boardIds`. */
  it('rejects when both sides omit boardIds', () => {
    const noIds = (name: string) =>
      board(name, [
        { id: 'tekst7', type: 'text' },
        { id: 'datum_1', type: 'date' },
        { id: 'board_relation_mkz4920y', type: 'board_relation', settings_str: '{}' },
      ]);

    expect(() => assertSchemasAgree(noIds('bron'), noIds('doel'))).toThrow(/boardIds/);
  });
});
