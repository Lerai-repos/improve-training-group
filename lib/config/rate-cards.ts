import type { SupabaseClient } from '@supabase/supabase-js';

import type { RateCard } from '@lib/calc';
import type { Database, RateCardRow } from '@lib/types/database';

/** Map a DB rate_card row to the calc-layer {@link RateCard} shape. */
export function mapRateCardRow(row: RateCardRow): RateCard {
  return {
    rateKey: row.rate_key,
    trainerId: row.trainer_id,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    hourlyRateCents: row.hourly_rate_cents,
  };
}

/**
 * Fetch rate cards, optionally filtered to one `rate_key`. Combine the result
 * with `resolveHourlyRateCents` from the calc layer to price a training.
 */
export async function getRateCards(
  supabase: SupabaseClient<Database>,
  rateKey?: string
): Promise<RateCard[]> {
  const base = supabase.from('rate_cards').select('*');
  const query = rateKey ? base.eq('rate_key', rateKey) : base;

  const { data, error } = await query;
  if (error) {
    throw new Error(`Failed to fetch rate_cards: ${error.message}`);
  }
  return (data ?? []).map(mapRateCardRow);
}
