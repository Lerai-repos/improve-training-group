import { EVAL_STATUS_COLUMN } from './knop';

/** Eén webhook zoals `webhooks(board_id:)` hem teruggeeft. */
export interface WebhookRij {
  readonly id: string;
  readonly event: string;
  /** Een Ruby-hash als tekst, bijvoorbeeld `{"columnId" => {... "columnId" => "x" ...}}`. */
  readonly config: string | null;
}

export const EVAL_STATUS_EVENT = 'change_status_column_value';

/** Zit deze webhook op `Eval Status`? Monday geeft geen URL terug, dus alleen zo te herkennen. */
export function isEvalStatusWebhook(rij: WebhookRij): boolean {
  return rij.event === EVAL_STATUS_EVENT && (rij.config ?? '').includes(`"${EVAL_STATUS_COLUMN}"`);
}

/**
 * Welke webhooks weg moeten nadat de onze is aangemaakt: elke andere op `Eval Status`.
 *
 * Monday geeft de URL van een webhook niet terug, dus "die van n8n" is niet te herkennen.
 * Wel dat er na deze stap precies één webhook op `Eval Status` hoort te staan: de onze. Dat
 * maakt het script ook herhaalbaar — een tweede keer draaien maakt een nieuwe en ruimt de
 * vorige op.
 */
export function teVerwijderen(rijen: readonly WebhookRij[], nieuwId: string): readonly string[] {
  return rijen.filter((r) => r.id !== nieuwId && isEvalStatusWebhook(r)).map((r) => r.id);
}

/**
 * De webhooks die al stonden voordat dit bestond, per bord.
 *
 * `188884618` op Agenda 2026 is 12-Oct-2026 met `pnpm eval:knop-webhook --apply` aangemaakt.
 * Zonder deze regel maakt de eerste run er een tweede naast, en verwerkt elke knopdruk op 2026
 * twee keer (de tweede wordt op triggerUuid tegengehouden, maar daar hoort niet op gerekend
 * te worden).
 */
export const ADOPTED_KNOP_WEBHOOKS: Readonly<Record<string, string>> = {
  '5087396949': '188884618',
};

export interface KnopWebhookStore {
  read(boardId: string): Promise<string | null>;
  write(boardId: string, webhookId: string): Promise<void>;
}

export interface KnopWebhookSyncDeps {
  /** De actieve agendaborden met de kolom Eval Status. */
  readonly boards: () => Promise<readonly { readonly boardId: string; readonly naam: string }[]>;
  listWebhooks(boardId: string): Promise<readonly WebhookRij[]>;
  /** Maakt hem aan (Monday doet de challenge) en geeft het id terug. */
  createWebhook(boardId: string, replaces: string | null): Promise<string>;
  readonly store: KnopWebhookStore;
  readonly dryRun: boolean;
}

export interface KnopAbonnement {
  readonly boardId: string;
  readonly naam: string;
  readonly webhookId: string | null;
}

export interface KnopWebhookSyncReport {
  readonly present: readonly KnopAbonnement[];
  readonly created: readonly KnopAbonnement[];
  readonly failed: readonly (KnopAbonnement & { readonly error: string })[];
}

/**
 * Elk agendabord met Eval Status op de knop aansluiten, zodat een nieuwe jaargang vanzelf
 * meedoet. Dezelfde drie regels als `syncWebhooks` voor de aanbevelingen:
 *
 * 1. **Nooit verwijderen.** Monday geeft geen URL terug, dus een vreemde webhook (die van n8n)
 *    is niet als vreemd te herkennen; alleen aanmaken kan niets van een ander kapotmaken.
 * 2. **Onthouden wat we zelf aanmaakten**, in KV. Verdwijnt dat id van het bord, dan opnieuw.
 * 3. **Een dubbele is onschuldig**: de route verwerkt een event één keer per triggerUuid.
 */
export async function syncEvalKnopWebhooks(
  deps: KnopWebhookSyncDeps
): Promise<KnopWebhookSyncReport> {
  const present: KnopAbonnement[] = [];
  const created: KnopAbonnement[] = [];
  const failed: (KnopAbonnement & { error: string })[] = [];
  const fout = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  for (const board of await deps.boards()) {
    const base = { boardId: board.boardId, naam: board.naam };
    try {
      const rows = await deps.listWebhooks(board.boardId);
      const recorded = await deps.store.read(board.boardId);
      const known = recorded ?? ADOPTED_KNOP_WEBHOOKS[board.boardId] ?? null;
      const staat = known !== null && rows.some((r) => r.id === known && isEvalStatusWebhook(r));

      if (staat) {
        if (recorded === null && !deps.dryRun) {
          await deps.store.write(board.boardId, known);
        }
        present.push({ ...base, webhookId: known });
        continue;
      }
      if (deps.dryRun) {
        created.push({ ...base, webhookId: null });
        continue;
      }
      const webhookId = await deps.createWebhook(board.boardId, known);
      await deps.store.write(board.boardId, webhookId);
      created.push({ ...base, webhookId });
    } catch (error) {
      failed.push({ ...base, webhookId: null, error: fout(error) });
    }
  }
  return { present, created, failed };
}
