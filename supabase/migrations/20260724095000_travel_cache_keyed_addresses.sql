-- M2b — review hardening (PII): travel_cache stored the normalized origin/destination
-- addresses verbatim, contradicting the no-raw-address guarantee. Replace them with a
-- KEYED HMAC hash (computed in the app via ADDRESS_HASH_KEY). Truncate first so no
-- existing raw address survives the rename; the cache simply rebuilds on next use.

truncate table travel_cache;

alter table travel_cache rename column origin_norm to origin_key;
alter table travel_cache rename column destination_norm to destination_key;

-- The unique constraint follows the rename automatically; assert the new shape.
comment on column travel_cache.origin_key is 'HMAC(ADDRESS_HASH_KEY, normalized origin address) — never the raw address';
comment on column travel_cache.destination_key is 'HMAC(ADDRESS_HASH_KEY, normalized destination address) — never the raw address';
