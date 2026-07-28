import type { Json } from '@lib/types/database.gen';

/**
 * Cast-free helpers for reading jsonb RPC returns and building jsonb payloads.
 * Narrowing the `Json` union (object variant has an index signature) lets us index
 * without an `as`.
 */

function asObject(v: Json | null | undefined): Record<string, Json | undefined> | null {
  if (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v)) {
    return v;
  }
  return null;
}

export function jsonBool(v: Json | null | undefined, key: string): boolean {
  const obj = asObject(v);
  return obj !== null && obj[key] === true;
}

export function jsonNumber(v: Json | null | undefined, key: string): number | null {
  const obj = asObject(v);
  const value = obj?.[key];
  return typeof value === 'number' ? value : null;
}

export function jsonString(v: Json | null | undefined, key: string): string | null {
  const obj = asObject(v);
  const value = obj?.[key];
  return typeof value === 'string' ? value : null;
}

/** Structure any value into a plain `Json` payload (for a jsonb column). */
export function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value));
}
