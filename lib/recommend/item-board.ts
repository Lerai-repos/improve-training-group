import { z } from 'zod';

/**
 * Which board an item lives on.
 *
 * The mutating routes need this because `GET` deliberately does not: a `view` holder may
 * open any item id that ever produced an artifact, which is account-wide and historical
 * by design. Spending money on a recalculation, or writing shared planning state, is a
 * different matter — those are confined to the Agenda board the engine is configured
 * for, so an item id from anywhere else in the account cannot drive them.
 *
 * A separate, minimal query rather than a field on `readTraining`: this runs on every
 * mutation, including ones that will be refused, and it should cost one id lookup rather
 * than a full column read.
 */

interface QueryClient {
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
}

const responseSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]),
        board: z.object({ id: z.union([z.string(), z.number()]) }).nullable(),
      })
    )
    .nullable(),
});

/** The board id, or null when the item does not exist or is not readable by our token. */
export function parseItemBoard(raw: unknown, itemId: string): string | null {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  // Monday answers a missing id with an empty list rather than an error, and echoes ids
  // as strings or numbers depending on the field — so match on the normalized form
  // instead of trusting position.
  const item = (parsed.data.items ?? []).find((i) => String(i.id) === itemId);
  return item?.board ? String(item.board.id) : null;
}

export interface ItemBoardReader {
  readBoardId(itemId: string): Promise<string | null>;
}

export function createItemBoardReader(client: QueryClient): ItemBoardReader {
  return {
    async readBoardId(itemId) {
      const doc = `query ($ids: [ID!]) { items(ids: $ids) { id board { id } } }`;
      return parseItemBoard(await client.query<unknown>(doc, { ids: [itemId] }), itemId);
    },
  };
}
