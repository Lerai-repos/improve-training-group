import { describe, expect, it } from 'vitest';

import { agendaBoardId } from '@lib/monday/board-config';

import { BRIEFING_AGENDA_COLUMNS as C } from '../columns';
import { BRIEFING_EXPECTED_COLUMNS, readBriefingTraining } from '../read';

import type { MondayGraphQLClient } from '@lib/monday/graphql-client';

/** Every column the reader asks for, filled with something plausible. */
function agendaItem(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    [C.opdrachtgever]: { text: null, display_value: 'Probiblio' },
    [C.themaRelation]: { linked_item_ids: ['900'] },
    [C.klanttitel]: { text: 'Speeddaten & Verbindend communiceren' },
    [C.duurTekst]: { text: '3 uur' },
    [C.datum]: { text: '24-03-2026', date: '2026-03-24' },
    [C.tijden]: { text: '09:30 - 12:30' },
    [C.deelnemers]: { text: '10-20' },
    [C.locatie]: { text: 'Valkenburg' },
    [C.taal]: { text: 'Nederlands' },
    [C.accountmanager]: { persons_and_teams: [{ id: 7, kind: 'person' }] },
    [C.contactpersoonNaam]: { text: 'Paula Hollander' },
    [C.klantcontactmoment]: { text: 'Telefonisch contact' },
    [C.qr]: { text: 'Nee' },
    [C.ieCode]: { text: '260818' },
    [C.label]: { text: 'IT' },
    [C.trainerRelation]: { linked_item_ids: ['500'] },
    [C.brie]: { text: 'Aanmaken' },
    [C.acteuraantal]: { text: '' },
    [C.opportunity]: { linked_item_ids: ['300'] },
    ...overrides,
  };
  return {
    id: '1',
    name: 'Probiblio',
    board: { id: agendaBoardId() },
    column_values: Object.entries(base).map(([id, v]) => ({ id, ...(v as object) })),
  };
}

interface FakeOpts {
  contactPhone?: string;
  noContact?: boolean;
  /** Meerdere contactpersonen aan de Opportunity, in koppelvolgorde. */
  contacts?: Array<{ id: string; name: string; phone: string }>;
  /** Overschrijft één kolom in het bordschema, om drift na te bootsen. */
  columnOverride?: { id: string; type?: string; settings_str?: string | null };
  /** Drift op de tweede sprong: Opportunity → Contacten. */
  oppSettings?: string;
  oppRelationType?: string;
  /** Laat een gekoppelde trainer weg uit het antwoord, zoals Monday bij een verwijderd item doet. */
  dropTrainer?: string;
  /** Idem voor een contactpersoon. */
  dropContact?: string;
  /** Bootst een hernoemde/verwijderde telefoonkolom op het trainersbord na. */
  dropPhoneColumn?: boolean;
  /** Draait het antwoord van items(ids:) om, zoals Monday mag doen. */
  reverseTrainers?: boolean;
  /** Trainer-ids die in de groep `Acteurs` op het trainersbord staan. */
  actorIds?: string[];
}

/** Een bord dat aan alle verwachtingen voldoet, tenzij de test iets omzet. */
function schema(opts: FakeOpts) {
  const columns = BRIEFING_EXPECTED_COLUMNS.map((e) => ({
    id: e.id,
    title: e.id,
    type: e.type,
    settings_str: e.settingsIncludes?.[0] ? `{${e.settingsIncludes[0]}}` : null,
  }));
  if (opts.columnOverride) {
    const at = columns.findIndex((c) => c.id === opts.columnOverride!.id);
    columns[at] = { ...columns[at]!, ...opts.columnOverride };
  }
  return [{ id: agendaBoardId(), name: 'Agenda', groups: [], columns, items_count: 1 }];
}

function client(item: unknown, opts: FakeOpts = {}) {
  const query = <T,>(doc: string, vars?: Record<string, unknown>): Promise<T> => {
    if (doc.includes('users(')) {
      return Promise.resolve({
        users: [{ id: 7, name: 'Dirkje Pril', mobile_phone: '+31648431025' }],
      } as T);
    }
    if (doc.includes('telefoon_mkn1hbyh')) {
      const asked = ((vars?.ids as string[]) ?? []).map(String);
      const namen: Record<string, [string, string]> = {
        '500': ['Lennart Bosschaart', '06-11111111'],
        '501': ['Tessa de Haas', '06-22222222'],
      };
      const order = opts.reverseTrainers ? [...asked].reverse() : asked;
      return Promise.resolve({
        items: order
          .filter((id) => id !== opts.dropTrainer)
          .map((id) => ({
            id,
            name: namen[id]?.[0] ?? `Trainer ${id}`,
            group: { id: (opts.actorIds ?? []).includes(id) ? 'nieuwe_groep22164__1' : 'topics' },
            column_values: opts.dropPhoneColumn
              ? []
              : [{ id: 'telefoon_mkn1hbyh', text: namen[id]?.[1] ?? '' }],
          })),
      } as T);
    }
    if (doc.includes('deal_contact')) {
      const ids = opts.noContact ? [] : (opts.contacts?.map((c) => c.id) ?? ['800']);
      return Promise.resolve({
        items: [{ id: '300', name: 'Opp', column_values: [{ id: 'deal_contact', linked_item_ids: ids }] }],
      } as T);
    }
    if (doc.includes('tekst__1')) {
      const list = opts.contacts ?? [
        { id: '800', name: 'Paula Hollander', phone: opts.contactPhone ?? '+31 6 42085076' },
      ];
      return Promise.resolve({
        items: list
          .filter((c) => c.id !== opts.dropContact)
          .map((c) => ({
            id: c.id,
            name: c.name,
            column_values: [{ id: 'tekst__1', text: c.phone }],
          })),
      } as T);
    }
    if (doc.includes('items(ids: $ids) { id name }')) {
      const asked = ((vars?.ids as string[]) ?? []).map(String);
      return Promise.resolve({
        items: asked.map((id) => ({ id, name: id === '900' ? 'Verbindend communiceren' : `Thema ${id}` })),
      } as T);
    }
    return Promise.resolve({ items: [item] } as T);
  };
  const getSchema = (ids: string[]) =>
    Promise.resolve(
      ids[0] === '1279052045'
        ? [
            {
              id: '1279052045',
              name: 'Opportunities',
              groups: [],
              columns: [
                {
                  id: 'deal_contact',
                  title: 'Contactpersoon',
                  type: opts.oppRelationType ?? 'board_relation',
                  settings_str: opts.oppSettings ?? '{"boardIds":[1279052020]}',
                },
              ],
              items_count: 1,
            },
          ]
        : schema(opts)
    );
  return { query, getSchema } as unknown as MondayGraphQLClient;
}

describe('readBriefingTraining', () => {
  it('reads a complete training across all four boards', async () => {
    const t = await readBriefingTraining(client(agendaItem()), '1');
    expect(t.opdrachtgever).toBe('Probiblio');
    expect(t.themas).toEqual(['Verbindend communiceren']);
    expect(t.accountmanager).toEqual({ naam: 'Dirkje Pril', mobiel: '+31648431025' });
    expect(t.contactpersoon).toEqual({ naam: 'Paula Hollander', telefoon: '+31 6 42085076' });
    expect(t.trainers).toEqual([
      { itemId: '500', naam: 'Lennart Bosschaart', telefoon: '06-11111111', isActeur: false },
    ]);
    expect(t.missing).toEqual([]);
  });

  /**
   * The failure this whole reader is shaped around. Monday omits an unrecognised column
   * id instead of erroring, so a renamed column arrives looking exactly like an empty
   * cell — and we would tell the adviseur they forgot to fill something in.
   */
  it('throws when a column is absent rather than treating it as empty', async () => {
    const item = agendaItem();
    item.column_values = item.column_values.filter((c) => c.id !== C.locatie);
    await expect(readBriefingTraining(client(item), '1')).rejects.toThrow(/ontbreekt/);
  });

  it('reports empty required fields instead of throwing', async () => {
    const t = await readBriefingTraining(
      client(agendaItem({ [C.locatie]: { text: '' }, [C.datum]: { text: '' } })),
      '1'
    );
    expect(t.missing.map((m) => m.label).sort()).toEqual(['Datum', 'Locatie']);
  });

  it('flags a training without a theme', async () => {
    const t = await readBriefingTraining(
      client(agendaItem({ [C.themaRelation]: { linked_item_ids: [] } })),
      '1'
    );
    expect(t.missing.map((m) => m.label)).toContain("Thema's");
  });

  /** Roughly half of all contacts have no number. That is normal, not missing data. */
  it('accepts a contact without a phone number', async () => {
    const t = await readBriefingTraining(client(agendaItem(), { contactPhone: '' }), '1');
    expect(t.contactpersoon).toEqual({ naam: 'Paula Hollander', telefoon: '' });
    expect(t.missing).toEqual([]);
  });

  /**
   * The agenda carries the name for 690 of 816 trainings, so an Opportunity with nothing
   * linked still leaves us a name worth printing. Only the number is unavailable.
   */
  it('falls back to the agenda name when the opportunity has no contact', async () => {
    const t = await readBriefingTraining(client(agendaItem(), { noContact: true }), '1');
    expect(t.contactpersoon).toEqual({ naam: 'Paula Hollander', telefoon: '' });
  });

  it('has no contactpersoon at all when the agenda name is empty too', async () => {
    const t = await readBriefingTraining(
      client(agendaItem({ [C.contactpersoonNaam]: { text: '' } }), { noContact: true }),
      '1'
    );
    expect(t.contactpersoon).toBeNull();
  });

  /**
   * 264 of 815 trainings leave Acteuraantal blank, so blank and zero are different
   * facts: one means "no acteur", the other means "nobody recorded it".
   */
  it('keeps blank and zero apart on Acteuraantal', async () => {
    const blank = await readBriefingTraining(client(agendaItem()), '1');
    expect(blank.acteuraantal).toBeNull();
    const zero = await readBriefingTraining(
      client(agendaItem({ [C.acteuraantal]: { text: '0' } })),
      '1'
    );
    expect(zero.acteuraantal).toBe(0);
  });

  /**
   * Measured on the live board: `Bedrijf` gives 0 of 816 through `text` and 816 of 816
   * through `display_value`. Reading only `text` reported "Opdrachtgever ontbreekt" on
   * every single training.
   */
  it('reads a mirror through display_value, not text', async () => {
    const t = await readBriefingTraining(client(agendaItem()), '1');
    expect(t.opdrachtgever).toBe('Probiblio');
    expect(t.missing.map((m) => m.label)).not.toContain('Opdrachtgever');
  });

  /**
   * `cell()` only proves the column id exists. Retype a board_relation and GraphQL omits
   * `linked_item_ids` entirely, which read as "no theme linked" — the same confusion
   * between drift and emptiness, one layer down.
   */
  it('throws when a relation column is no longer a relation', async () => {
    const item = agendaItem({ [C.themaRelation]: {} });
    await expect(readBriefingTraining(client(item), '1')).rejects.toThrow(/board-relatie/);
  });

  /**
   * An Opportunity can carry several contacts and the first link is not necessarily the
   * one for this training. Taking it blind puts the wrong name AND the wrong mobile
   * number in a document that goes to a trainer, and it looks entirely normal.
   */
  it('takes the contact named on the agenda, not the first one linked', async () => {
    const t = await readBriefingTraining(
      client(agendaItem(), {
        contacts: [
          { id: '801', name: 'Marco de Vries', phone: '+31 6 11111111' },
          { id: '800', name: 'Paula Hollander', phone: '+31 6 42085076' },
        ],
      }),
      '1'
    );
    expect(t.contactpersoon).toEqual({ naam: 'Paula Hollander', telefoon: '+31 6 42085076' });
  });

  it('keeps the agenda name when no linked contact matches it', async () => {
    const t = await readBriefingTraining(
      client(agendaItem(), { contacts: [{ id: '801', name: 'Marco de Vries', phone: '+31 6 11111111' }] }),
      '1'
    );
    expect(t.contactpersoon).toEqual({ naam: 'Paula Hollander', telefoon: '' });
  });

  it('does not guess when the agenda has no name and several contacts are linked', async () => {
    const t = await readBriefingTraining(
      client(agendaItem({ [C.contactpersoonNaam]: { text: '' } }), {
        contacts: [
          { id: '801', name: 'Marco de Vries', phone: '+31 6 11111111' },
          { id: '802', name: 'Ans Bakker', phone: '+31 6 22222222' },
        ],
      }),
      '1'
    );
    expect(t.contactpersoon).toBeNull();
  });

  /** The label picks the template, so a blank one means there is nothing to generate. */
  it('treats label, tijden and voertaal as required', async () => {
    const t = await readBriefingTraining(
      client(agendaItem({ [C.label]: { text: '' }, [C.tijden]: { text: '' }, [C.taal]: { text: '' } })),
      '1'
    );
    expect(t.missing.map((m) => m.label).sort()).toEqual(['Label', 'Tijden', 'Voertaal']);
  });

  /** TMT, YNS, ST and Email exist on the board (16 trainings) but have no template. */
  it('rejects a label that has no template', async () => {
    const t = await readBriefingTraining(client(agendaItem({ [C.label]: { text: 'TMT' } })), '1');
    expect(t.missing.map((m) => m.label).join()).toMatch(/TMT.*geen sjabloon/);
  });

  /**
   * Monday returns `null` as well as `[]` for an empty relation — `decode.ts` in this repo
   * already types it that way. Rejecting null would crash a training that simply has no
   * trainer yet, instead of reporting it as incomplete.
   */
  it('accepts a present-but-null relation as empty', async () => {
    const t = await readBriefingTraining(
      client(agendaItem({ [C.trainerRelation]: { linked_item_ids: null } })),
      '1'
    );
    expect(t.trainers).toEqual([]);
    expect(t.missing.map((m) => m.label)).toContain('Trainer');
  });

  /**
   * The failure no item query can see: a relation that stays a relation but is repointed
   * at another board. `linked_item_ids` is still a perfectly valid array, and the briefing
   * would fill in names from somewhere else entirely.
   */
  it('refuses a relation repointed at another board', async () => {
    await expect(
      readBriefingTraining(
        client(agendaItem(), {
          columnOverride: { id: C.themaRelation, settings_str: '{"boardIds":[99999]}' },
        }),
        '1'
      )
    ).rejects.toThrow();
  });

  /**
   * `text` on a date column follows the API user's profile format. On a DD-MM-YYYY
   * profile it is non-empty, so readiness passes, but the deadline silently disappears.
   * `DateValue.date` is always YYYY-MM-DD.
   */
  it('prefers DateValue.date over the profile-formatted text', async () => {
    const t = await readBriefingTraining(
      client(agendaItem({ [C.datum]: { text: '24-03-2026', date: '2026-03-24' } })),
      '1'
    );
    expect(t.datum).toBe('2026-03-24');
  });

  it('reports a training with no trainer as incomplete', async () => {
    const t = await readBriefingTraining(
      client(agendaItem({ [C.trainerRelation]: { linked_item_ids: [] } })),
      '1'
    );
    expect(t.missing.map((m) => m.label)).toContain('Trainer');
  });

  /**
   * The mirror must not merely be a mirror; it has to look through the same source. Re-source
   * it and every briefing quietly names a different client.
   */
  it('refuses a re-sourced Opdrachtgever mirror', async () => {
    await expect(
      readBriefingTraining(
        client(agendaItem(), {
          columnOverride: {
            id: C.opdrachtgever,
            settings_str: '{"displayed_linked_columns":{"999":["andere_kolom"]}}',
          },
        }),
        '1'
      )
    ).rejects.toThrow();
  });

  /** The second hop deserves the same guard as the first. */
  it('refuses an Opportunity contact relation repointed at another board', async () => {
    await expect(
      readBriefingTraining(client(agendaItem(), { oppSettings: '{"boardIds":[424242]}' }), '1')
    ).rejects.toThrow();
  });

  /**
   * `items(ids:)` searches the whole account. A copy of the agenda board exists for our own
   * work, so an id from there would be read against the configured board's schema.
   */
  it('refuses an item that lives on a different board', async () => {
    const item = { ...agendaItem(), board: { id: 'een-ander-bord' } };
    await expect(readBriefingTraining(client(item), '1')).rejects.toThrow(/niet op het ingestelde/);
  });

  /**
   * Monday omits a deleted linked item from the response. With two trainers that yields
   * one, readiness still passes, and the co-trainer disappears from the briefing.
   */
  it('fails when a linked trainer cannot be resolved', async () => {
    await expect(
      readBriefingTraining(
        client(agendaItem({ [C.trainerRelation]: { linked_item_ids: ['500', '501'] } }), {
          dropTrainer: '501',
        }),
        '1'
      )
    ).rejects.toThrow(/konden niet worden opgehaald/);
  });

  /**
   * The relation order decides who is lead and who is co-trainer. `items(ids:)` may answer
   * in any order it likes, and swapping them hands the co-trainer the block that says they
   * are responsible for the client contact.
   */
  it('keeps trainers in relation order, whatever order Monday answers in', async () => {
    const t = await readBriefingTraining(
      client(agendaItem({ [C.trainerRelation]: { linked_item_ids: ['500', '501'] } }), {
        reverseTrainers: true,
      }),
      '1'
    );
    expect(t.trainers.map((x) => x.itemId)).toEqual(['500', '501']);
    expect(t.trainers[0]?.naam).toBe('Lennart Bosschaart');
  });

  /**
   * De trainerrelatie mengt trainers en acteurs. Zonder dit onderscheid telt een acteur mee
   * als co-trainer: gemeten heeft `Acteuraantal=1` met twee gekoppelde personen er 20 keer
   * eentje uit de groep `Acteurs` bij.
   */
  it('marks a linked trainer who sits in the Acteurs group', async () => {
    const t = await readBriefingTraining(
      client(agendaItem({ [C.trainerRelation]: { linked_item_ids: ['500', '501'] } }), {
        actorIds: ['501'],
      }),
      '1'
    );
    expect(t.trainers.map((x) => [x.itemId, x.isActeur])).toEqual([
      ['500', false],
      ['501', true],
    ]);
  });

  /**
   * De relatie mengt trainers en acteurs, dus een training met alléén een acteur eraan heeft
   * wel een gevulde relatie en tóch geen ontvanger. Op `trainers.length` kijken zou hem als
   * compleet afvinken en een briefing beloven die nergens heen kan.
   */
  it('treats an actor-only relation as having no trainer', async () => {
    const t = await readBriefingTraining(
      client(agendaItem({ [C.trainerRelation]: { linked_item_ids: ['501'] } }), {
        actorIds: ['501'],
      }),
      '1'
    );
    expect(t.trainers).toHaveLength(1);
    expect(t.missing.map((m) => m.label)).toContain('Trainer');
  });

  it('accepts a relation holding a trainer plus an actor', async () => {
    const t = await readBriefingTraining(
      client(agendaItem({ [C.trainerRelation]: { linked_item_ids: ['500', '501'] } }), {
        actorIds: ['501'],
      }),
      '1'
    );
    expect(t.missing.map((m) => m.label)).not.toContain('Trainer');
  });

  /**
   * Two contacts linked, one deleted, leaves exactly one — and the "only one candidate,
   * so that must be them" rule would guess on a relation that was actually ambiguous.
   */
  it('does not guess when a linked contact could not be resolved', async () => {
    await expect(
      readBriefingTraining(
        client(agendaItem({ [C.contactpersoonNaam]: { text: '' } }), {
          contacts: [
            { id: '801', name: 'Marco de Vries', phone: '+31 6 11111111' },
            { id: '802', name: 'Ans Bakker', phone: '+31 6 22222222' },
          ],
          dropContact: '802',
        }),
        '1'
      )
    ).rejects.toThrow(/contactpersonen/);
  });

  /** A filled relation that resolves to nothing is drift, not "this client has no contact". */
  it('fails when the linked Opportunity cannot be resolved', async () => {
    const item = agendaItem();
    const c = client(item, {});
    const original = c.query.bind(c);
    const patched = {
      ...c,
      query: <T,>(doc: string, vars?: Record<string, unknown>): Promise<T> =>
        doc.includes('deal_contact')
          ? (Promise.resolve({ items: [] }) as Promise<T>)
          : original(doc, vars),
    } as unknown as MondayGraphQLClient;
    await expect(readBriefingTraining(patched, '1')).rejects.toThrow(/Opportunity/);
  });

  /**
   * A renamed cross-board column would otherwise strip every phone number silently, the
   * same trap `cell()` guards against on the agenda item.
   */
  it('throws when the trainer phone column is absent rather than blanking it', async () => {
    await expect(
      readBriefingTraining(client(agendaItem(), { dropPhoneColumn: true }), '1')
    ).rejects.toThrow(/ontbreekt/);
  });

  it('refuses a training it cannot find', async () => {
    const empty = {
      query: <T,>() => Promise.resolve({ items: [] } as T),
      getSchema: () => Promise.resolve(schema({})),
    } as unknown as MondayGraphQLClient;
    await expect(readBriefingTraining(empty, '99')).rejects.toThrow(/niet gevonden/);
  });
});
