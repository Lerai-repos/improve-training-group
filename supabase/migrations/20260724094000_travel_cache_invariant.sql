-- M2b — review hardening: enforce the travel_cache row invariant in SQL so a
-- malformed row can never be read back and silently priced as free travel.
--   * condition must be exactly ROUTE_EXISTS or ROUTE_NOT_FOUND;
--   * ROUTE_EXISTS ⇒ both metrics present, finite, non-negative;
--   * ROUTE_NOT_FOUND ⇒ both metrics null (a negative row carries no distance/time).

alter table travel_cache
  add constraint travel_cache_condition_metrics_ck check (
    (condition = 'ROUTE_EXISTS'
       and distance_km is not null and distance_km >= 0
       and duration_minutes is not null and duration_minutes >= 0)
    or
    (condition = 'ROUTE_NOT_FOUND'
       and distance_km is null and duration_minutes is null)
  );
