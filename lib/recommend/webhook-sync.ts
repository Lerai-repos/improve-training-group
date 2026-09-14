import type { KvStore } from './kv';

/**
 * Elk agendabord dat aanbevelingen krijgt, abonneren op de groepsverplaatsing.
 *
 * Monday stuurt `item_moved_to_specific_group` alleen voor een bord en groep waar een webhook
 * voor is aangemaakt. Zonder dit deed een gedupliceerde 2027 niets zodra iemand een training
 * naar Inplannen sleepte, en niemand zag waarom.
 *
 * ## Drie regels die dit veilig maken
 *
 * 1. **Nooit verwijderen.** Monday geeft bij een webhook geen URL terug, en n8n luistert naar
 *    hetzelfde event op dezelfde groep. Wat niet van ons is, is dus niet te herkennen, en
 *    alleen aanmaken kan niets van een ander kapotmaken.
 * 2. **Onthouden wat we zelf aanmaakten**, in KV. Alleen zo is "staat er al" te beantwoorden,
 *    om dezelfde reden. Is het onthouden id op het bord verdwenen, dan wordt hij opnieuw
 *    aangemaakt.
 * 3. **Een dubbele webhook is onschuldig.** Crasht dit tussen aanmaken en onthouden, dan maakt
 *    de volgende run er nog een. Beide leveren hetzelfde event af, en de wachtrij ontdubbelt
 *    op trigger-uuid; in het slechtste geval rekent een training twee keer.
 */

export const MOVE_EVENT = 'item_moved_to_specific_group';

/**
 * De twee webhooks die `pnpm webhook:register` op Agenda 2026 aanmaakte, voordat dit bestond.
 *
 * Gemeten 14-Sep-2026 met de `webhooks`-query. `181756731` en `181756735` zijn één run van ons
 * script, direct na elkaar aangemaakt; `152998532` op dezelfde groep is die van n8n. Zonder
 * deze lijst zou de eerste run beide opnieuw aanmaken, en rekent elke training op 2026 dubbel.
 */
export const ADOPTED_WEBHOOKS: Readonly<Record<string, string>> = {
  '5087396949:group_mkwtj07a': '181756731',
  '5087396949:nieuwe_groep': '181756735',
};

export interface WebhookRow {
  readonly id: string;
  readonly event: string;
  readonly config: string | null;
}

export interface SubscriptionStore {
  read(boardId: string, groupId: string): Promise<string | null>;
  write(boardId: string, groupId: string, webhookId: string): Promise<void>;
}

/** Zonder verloop: een abonnement verloopt ook niet. */
export function createSubscriptionStore(kv: KvStore): SubscriptionStore {
  const key = (boardId: string, groupId: string): string =>
    `webhook-subscription:v1:${boardId}:${groupId}`;
  return {
    read: (boardId, groupId) => kv.get(key(boardId, groupId)),
    write: (boardId, groupId, webhookId) => kv.set(key(boardId, groupId), webhookId),
  };
}

export interface WebhookSyncDeps {
  /** De borden die aanbevelingen krijgen. */
  readonly boards: () => Promise<readonly { readonly boardId: string; readonly naam: string }[]>;
  readonly triggerGroupIds: readonly string[];
  listWebhooks(boardId: string): Promise<readonly WebhookRow[]>;
  /**
   * Maakt de webhook aan en geeft het id terug. Monday doet daarbij de challenge.
   *
   * `replaces` is het id dat niet meer op het bord staat, of `null` bij een eerste abonnement.
   * Het hoort in de idempotency-sleutel; zie `webhookIdempotencyKey`.
   */
  createWebhook(boardId: string, groupId: string, replaces: string | null): Promise<string>;
  readonly store: SubscriptionStore;
  /** Alleen kijken: wat zou er aangemaakt worden. */
  readonly dryRun: boolean;
}

/**
 * De idempotency-sleutel voor één aanmaakpoging.
 *
 * De mutatieclient probeert opnieuw bij een netwerkfout of een 5xx. Is de webhook dan al
 * aangemaakt en ging alleen het antwoord verloren, dan maakte de herhaling er een tweede bij.
 * Die werd nergens onthouden, en liet elke verplaatsing voorgoed twee keer binnenkomen. Met
 * een sleutel geeft Monday een herhaling binnen 30 minuten het eerste antwoord terug.
 *
 * **Het vervangen id zit in de sleutel.** Alleen bord en groep zou na een verwijderde webhook
 * binnen die 30 minuten het oude, verwijderde id teruggeven in plaats van een nieuwe te maken.
 */
export function webhookIdempotencyKey(
  boardId: string,
  groupId: string,
  replaces: string | null
): string {
  return `webhook-subscription:${boardId}:${groupId}:${replaces ?? 'nieuw'}`;
}

export interface Subscription {
  readonly boardId: string;
  readonly naam: string;
  readonly groupId: string;
  readonly webhookId: string | null;
}

export interface WebhookSyncReport {
  readonly present: readonly Subscription[];
  readonly created: readonly Subscription[];
  readonly failed: readonly (Subscription & { readonly error: string })[];
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const asId = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

/**
 * Het antwoord op `webhooks(board_id:)`, gecontroleerd.
 *
 * Werpt in plaats van `[]` te geven: "er staan geen webhooks" leidt tot aanmaken, dus een
 * onleesbaar antwoord mag daar niet op lijken.
 */
export function parseWebhookRows(data: unknown): WebhookRow[] {
  if (!isRecord(data) || !Array.isArray(data.webhooks)) {
    throw new Error('Monday gaf geen lijst met webhooks terug');
  }
  return data.webhooks.flatMap((raw: unknown): WebhookRow[] => {
    if (!isRecord(raw)) {
      return [];
    }
    const id = asId(raw.id);
    const event = asId(raw.event);
    if (id === null || event === null) {
      return [];
    }
    return [{ id, event, config: typeof raw.config === 'string' ? raw.config : null }];
  });
}

/** Het id uit `create_webhook`, of een fout: zonder id valt er niets te onthouden. */
export function parseCreatedWebhookId(data: unknown): string {
  const created = isRecord(data) && isRecord(data.create_webhook) ? data.create_webhook : null;
  const id = created === null ? null : asId(created.id);
  if (id === null) {
    throw new Error('Monday gaf bij create_webhook geen id terug');
  }
  return id;
}

/** Staat dit id nog op het bord, als groepsverplaatsing naar deze groep? */
function stillThere(rows: readonly WebhookRow[], webhookId: string, groupId: string): boolean {
  return rows.some(
    (row) =>
      row.id === webhookId && row.event === MOVE_EVENT && (row.config ?? '').includes(groupId)
  );
}

export async function syncWebhooks(deps: WebhookSyncDeps): Promise<WebhookSyncReport> {
  const present: Subscription[] = [];
  const created: Subscription[] = [];
  const failed: (Subscription & { error: string })[] = [];

  for (const board of await deps.boards()) {
    const base = { boardId: board.boardId, naam: board.naam };

    let rows: readonly WebhookRow[];
    try {
      rows = await deps.listWebhooks(board.boardId);
    } catch (error) {
      // Zonder de lijst weten we niet wat er staat; aanmaken zou blind dubbelen.
      for (const groupId of deps.triggerGroupIds) {
        failed.push({ ...base, groupId, webhookId: null, error: message(error) });
      }
      continue;
    }

    for (const groupId of deps.triggerGroupIds) {
      try {
        const recorded = await deps.store.read(board.boardId, groupId);
        const known = recorded ?? ADOPTED_WEBHOOKS[`${board.boardId}:${groupId}`] ?? null;

        if (known !== null && stillThere(rows, known, groupId)) {
          if (recorded === null && !deps.dryRun) {
            await deps.store.write(board.boardId, groupId, known);
          }
          present.push({ ...base, groupId, webhookId: known });
          continue;
        }

        if (deps.dryRun) {
          created.push({ ...base, groupId, webhookId: null });
          continue;
        }
        const webhookId = await deps.createWebhook(board.boardId, groupId, known);
        await deps.store.write(board.boardId, groupId, webhookId);
        created.push({ ...base, groupId, webhookId });
      } catch (error) {
        failed.push({ ...base, groupId, webhookId: null, error: message(error) });
      }
    }
  }

  return { present, created, failed };
}
