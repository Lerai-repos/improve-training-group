# M2a — reviewed evidence + acknowledgement decisions

This directory holds the **durable, committed** evidence for the M2a Monday sync (it survives the
gitignored `snapshots/` purge). Raw PII dumps stay local under `snapshots/monday/`.

- **`audit-report.md`** — sanitized aggregate audit (`pnpm audit:mapping`): counts, comparison
  rules, anomaly ids, input hashes. No trainer/personal PII.
- **`acknowledgements.json`** — reviewed human decisions consumed by `pnpm sync:monday`.

## Flow

1. `pnpm snapshot:monday` — hardened read-only dump (fatal completeness/coherence/version gates).
2. `pnpm audit:mapping` — regenerates `audit-report.md`.
3. `pnpm sync:monday` (**dry-run, no DB writes**) — validates the full pull and **exits nonzero**
   with the exact worklist while decisions are unfilled:
   - `noBedrijfKlant` — the 18 trainings with no Bedrijf mirror → confirm each company name.
   - `klantAliases` — fingerprint collisions (e.g. `De Heus` / `De Heus (copy)`) → `merge`
     (with a `canonical`) or `separate`.
   - `qualConflicts` — trainer×theme in two colours → the reviewed effective `green`/`red`.
   - `acknowledgedGroups` — trainer groups intentionally left unmapped (imported anyway).
4. Fill `acknowledgements.json`, re-run the dry-run until **exit 0**.
5. `pnpm sync:monday --apply` (asserted **non-prod** target) — one atomic
   `apply_monday_snapshot` transaction; records the run in `sync_runs`.

Every non-fatal item is an **explicitly-allowed** anomaly recorded in the run manifest — never a
silent warning.
