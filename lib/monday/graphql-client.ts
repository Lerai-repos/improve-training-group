import {
  assertApiVersion,
  assertCoherent,
  assertCountMatches,
  assertNoDuplicateIds,
  type Inventory,
} from './completeness';

/**
 * Low-level Monday GraphQL transport, fail-closed.
 *
 *  - PAT in `Authorization` WITHOUT a `Bearer` prefix (Monday's documented form).
 *  - Every response must report the requested `API-Version` (silent fallback throws).
 *  - GraphQL errors arrive HTTP 200 with an `errors[]` body — the body is checked.
 *  - **Read-only:** any document containing a `mutation` operation is rejected
 *    before it leaves the process (the read port must not be able to write).
 *  - Per-request timeout (AbortController); retries on 429/5xx/timeout with backoff.
 *
 * `fetchBoardItems` additionally proves completeness (count == items_count, no
 * duplicate ids) and coherence (before/after `updated_at` inventory unchanged).
 */

const DEFAULT_ENDPOINT = 'https://api.monday.com/v2';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 300;
const PAGE_LIMIT = 100;

const INVENTORY_FIELDS = 'id updated_at';

export interface MondayClientOptions {
  token: string;
  apiVersion: string;
  endpoint?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface BoardMeta {
  id: string;
  name: string;
  groups: Array<{ id: string; title: string }>;
  columns: Array<{ id: string; title: string; type: string; settings_str: string | null }>;
  items_count: number | null;
}

export interface Preflight {
  account: { id: string; name: string };
  reportedVersion: string | null;
  supportedVersions: string[];
}

interface WithId {
  id: string;
  updated_at?: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry delay: honor a valid `Retry-After` (seconds), else exponential backoff. */
function retryAfterMs(header: string | null, attempt: number): number {
  const seconds = header !== null ? Number(header) : Number.NaN;
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  return BASE_BACKOFF_MS * Math.pow(2, attempt);
}

export interface MondayGraphQLClient {
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
  preflight(): Promise<Preflight>;
  getSchema(boardIds: string[]): Promise<BoardMeta[]>;
  /** Fetch every item on a board, gated: complete (count) + coherent (updated_at). */
  fetchBoardItems<T extends WithId>(
    boardId: string,
    fields: string,
    itemsCount: number | null
  ): Promise<T[]>;
  lastReportedVersion(): string | null;
}

export function createMondayGraphQLClient(opts: MondayClientOptions): MondayGraphQLClient {
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  let reportedVersion: string | null = null;

  async function query<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (/\bmutation\b/i.test(document)) {
      throw new Error('MondayReadPort: mutation documents are rejected (read-only)');
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Authorization: opts.token,
            'Content-Type': 'application/json',
            'API-Version': opts.apiVersion,
          },
          body: JSON.stringify({ query: document, variables }),
          signal: controller.signal,
        });
      } catch (err) {
        if (attempt < maxRetries) {
          await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }

      reportedVersion = res.headers.get('API-Version') ?? reportedVersion;

      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxRetries) {
          await sleep(retryAfterMs(res.headers.get('Retry-After'), attempt));
          continue;
        }
      }
      if (!res.ok) {
        throw new Error(`Monday API ${res.status}: ${await res.text()}`);
      }

      assertApiVersion(res.headers.get('API-Version'), opts.apiVersion);

      const body: { data?: T; errors?: Array<{ message: string }> } = await res.json();
      if (body.errors && body.errors.length > 0) {
        const msg = body.errors.map((e) => e.message).join('; ');
        if (/complexity|minute|budget/i.test(msg) && attempt < maxRetries) {
          await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt + 1));
          continue;
        }
        throw new Error(`Monday GraphQL error: ${msg}`);
      }
      if (!body.data) {
        throw new Error('Monday GraphQL: empty data');
      }
      return body.data;
    }
    throw new Error('Monday GraphQL: retries exhausted');
  }

  async function preflight(): Promise<Preflight> {
    const v = await query<{ versions: Array<{ value: string; kind: string }> }>(
      `query { versions { value kind } }`
    );
    const supportedVersions = v.versions.map((x) => x.value);
    if (!supportedVersions.includes(opts.apiVersion)) {
      throw new Error(
        `Pinned API version ${opts.apiVersion} not supported: ${supportedVersions.join(', ')}`
      );
    }
    const me = await query<{ me: { id: string; name: string } | null }>(`query { me { id name } }`);
    if (!me.me) {
      throw new Error('Token did not resolve an account (me == null)');
    }
    return { account: me.me, reportedVersion, supportedVersions };
  }

  async function getSchema(boardIds: string[]): Promise<BoardMeta[]> {
    const r = await query<{ boards: BoardMeta[] | null }>(
      `query ($ids: [ID!]) {
        boards(ids: $ids) {
          id name
          groups { id title }
          columns { id title type settings_str }
          items_count
        }
      }`,
      { ids: boardIds }
    );
    return r.boards ?? [];
  }

  async function fetchAllPages<T>(boardId: string, fields: string): Promise<T[]> {
    const first = await query<{
      boards: Array<{ items_page: { cursor: string | null; items: T[] } }> | null;
    }>(
      `query ($ids: [ID!], $limit: Int!) {
        boards(ids: $ids) { items_page(limit: $limit) { cursor items { ${fields} } } }
      }`,
      { ids: [boardId], limit: PAGE_LIMIT }
    );
    const board = first.boards?.[0];
    if (!board) {
      throw new Error(`board ${boardId} not returned`);
    }
    const items: T[] = [...board.items_page.items];
    const seen = new Set<string>();
    let cursor = board.items_page.cursor;
    while (cursor) {
      if (seen.has(cursor)) {
        throw new Error(`repeated cursor on board ${boardId} — pagination not advancing`);
      }
      seen.add(cursor);
      const next = await query<{ next_items_page: { cursor: string | null; items: T[] } }>(
        `query ($cursor: String!, $limit: Int!) {
          next_items_page(limit: $limit, cursor: $cursor) { cursor items { ${fields} } }
        }`,
        { cursor, limit: PAGE_LIMIT }
      );
      items.push(...next.next_items_page.items);
      cursor = next.next_items_page.cursor;
    }
    return items;
  }

  async function inventory(boardId: string): Promise<Inventory> {
    const items = await fetchAllPages<WithId>(boardId, INVENTORY_FIELDS);
    const inv: Inventory = new Map();
    for (const it of items) {
      inv.set(it.id, it.updated_at ?? '');
    }
    return inv;
  }

  async function fetchBoardItems<T extends WithId>(
    boardId: string,
    fields: string,
    itemsCount: number | null
  ): Promise<T[]> {
    // A cheap {id, updated_at} snapshot BEFORE the heavy read, then the read itself.
    // The `after` inventory is derived from the fetched items (`fields` includes
    // updated_at) rather than a third full pagination pass — so coherence compares
    // the baseline against the exact data we're about to use (an item added,
    // removed, or edited between the two still trips assertCoherent).
    const before = await inventory(boardId);
    const items = await fetchAllPages<T>(boardId, fields);
    const after: Inventory = new Map();
    for (const it of items) {
      after.set(it.id, it.updated_at ?? '');
    }

    const ids = items.map((i) => i.id);
    assertNoDuplicateIds(ids, boardId);
    assertCoherent(before, after, boardId);
    assertCountMatches(new Set(ids).size, itemsCount, boardId);
    return items;
  }

  return {
    query,
    preflight,
    getSchema,
    fetchBoardItems,
    lastReportedVersion: () => reportedVersion,
  };
}
