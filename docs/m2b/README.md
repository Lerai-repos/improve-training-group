# M2b — Trainer Recommendation Engine (runbook & handoff)

The recommendation engine re-implements the legacy n8n **flow-6** on the modern stack
(Next.js on Vercel + Supabase Postgres + TypeScript). Given a training on the **Agenda 2026**
board, it ranks the eligible trainers by cost (then travel) and writes a single status back into
Monday. There is **no frontend** — the output is surfaced in Monday. The sortable in-Monday list
(iframe item-view) is a separate later spec.

This doc is the operational reference: what it does, how to run it locally, every env var, the
ordered go-live checklist, and how to operate/debug it. The design/decision record lives in the
plan (`~/.claude/plans/glimmering-meandering-valley.md`); the acceptance evidence lives in
`docs/m2a/recommend-parity.md`.

---

## 1. What it does (flow)

```
Monday webhook (2 triggers, see below)
  → route: echo the setup challenge (unsigned — Monday sends it without a signature) → for real
    events verify the Monday signature → enqueue_recommendation_run (atomic dedup + per-training
    generation) → 200 → waitUntil(drain) as an opportunistic kick
  → worker (Vercel Cron every 5 min + opportunistic drain): claim a queued run via lease
      1. LIVE-read the training + all 4 qualification colour columns of each linked theme
      2. effective-green per (trainer, theme) — reuse deriveEffective + acknowledged-conflict logic
      3. coherent snapshot read of trainer master + scores (one RPC / one txn)
      4. eligibility = recommendable cohort ∩ effective-green-for-EVERY-live-theme ∩ has-themes
      5. address → { travel_required | no_travel_confirmed:online | unresolved→FOUT | error→FOUT }
      6. travel: cache → Google Routes computeRouteMatrix; origin-aware failure taxonomy
      7. calc (lib/calc) → rank (cost↑ then travel↑; score layers inert until M3)
      8. capture immutable, PII-minimized input_artifact (JSONB) + canonical-JSON hash
      9. persist apply_recommendations: generation CAS (stale→superseded) → append → status=computed
     10. deliver under a per-training delivery lease + fencing → converge Monday status
```

**Triggers** (two Monday webhook subscriptions):
- **Group move** into *Inplannen* (`item_moved_to_specific_group`) — writes the terminal status directly (no RUN).
- **Aanbevelingen button** (`button_mkzw7xx2`, sets RUN → `change_status_column_value`) — RUN is visible while queued/running, then overwritten with the terminal result.

**The engine never writes RUN** (that would self-trigger the webhook and supersede its own job). The
writer allowlist is exactly `{ GEREED, GEEN MATCH, FOUT }` — no `reset`, no RUN.

**Terminal statuses:**
| Status | Meaning |
|--------|---------|
| `GEREED` | Ranked recommendations produced and persisted. |
| `GEEN MATCH` | No eligible trainer (zero live themes, nobody effective-green for every theme, or nobody who can be priced). |
| `FOUT` | A hard failure that must not be silently priced: stale snapshot, missing/≤0 duration, invalid date, unresolved/vague location, HQ/destination route failure, transient Routes/AI failure. |

**Exclusion reasons** (recorded per run in `recommendation_runs.excluded_trainers`, never fatal):

| Reason | Meaning |
|---|---|
| `no_rate` | Eligible but no resolvable rate card — e.g. a selected group whose trainers have no rate. Skipped so the rest of the run still succeeds. |
| `no_address` | Trainer has no address, so travel can't be computed. |
| `route_not_found` | Google Routes can't route from that trainer's address. |

---

## 2. Architecture map

**Database** (`supabase/migrations/`):
- `20260724090000_recommendation_tables.sql` — `recommendation_generation` (per-training atomic counter),
  `recommendation_runs` (durable job + provenance + lifecycle), `recommendations` (append-only history,
  `unique(run_id, trainer_id)`), `current_recommendations` view (`security_invoker`, max-generation run
  only if delivered), `travel_cache`. All new tables RLS deny-all.
- `20260724090100_recommendation_rpcs.sql` — `enqueue_recommendation_run`, `claim_recommendation_run`,
  `read_recommendation_inputs`, `eligible_trainers_for_training` (snapshot oracle — tests/parity only),
  `apply_recommendations`, `acquire_delivery_lease`, `finalize_delivery`. SECURITY INVOKER,
  `search_path=''`, service_role-only.
- `20260724091000_recommendation_rpc_hardening.sql` — `read_recommendation_inputs` returns
  `sync_run_started_at` (freshness gate); `finalize_delivery` gains an owner fence.
- `20260724092000` / `…093000` / `…094000` / `…095000` — delivery-lease same-run fence; atomic
  owner-fenced `finalize_delivery` + `claim_recommendation_run_by_id`; `travel_cache` row invariant;
  keyed (HMAC) address cache keys.
- `20260728120000` / `…120100` / `…120200` / `…120300` — seed `RECOMMENDABLE_TRAINER_GROUPS`;
  `read_recommendation_inputs` also returns `tr.id`; `trainer_group_readiness` RPC; RPC grants revoked
  from `anon`/`authenticated` (a plain `revoke from public` did **not** remove Supabase's explicit
  grants, so the "service_role-only" claim was previously untrue).

**Engine** (`lib/recommend/`):
- Pure core: `types.ts`, `eligibility.ts`, `scores.ts` (inert until M3), `pricing.ts` (wires `lib/calc`
  + `rankTrainers`), `travel-enrich.ts` (single round-trip doubling point), `artifact.ts` (canonical JSON + hash).
- Adapters: `address.ts` (discriminated `AddressDecision`), `travel.ts` (Routes `computeRouteMatrix`),
  `travel-cache.ts`, `completion.ts` (OpenRouter), `monday-reader.ts` (live reads, fail-closed),
  `monday-status.ts` (scoped writer).
- Orchestration: `travel-resolve.ts` (origin-aware), `persist.ts` (generation CAS), `delivery.ts`
  (lease + fencing + repair), `service.ts` (`runRecommendation` pipeline), `worker.ts` (claim/drain/redeliver).
- Wiring: `event.ts` (parse webhook), `signature.ts` (verify Monday JWT), `webhook.ts`, `cron.ts`,
  `engine-config.ts`, `deps.ts`, `index.ts` (barrel).

**Routes:**
- `app/api/webhooks/monday/recommendations/route.ts` — challenge (unsigned) → verify signature → enqueue → 200 → opportunistic drain.
- `app/api/cron/recommendations/route.ts` — `Bearer $CRON_SECRET`, drains queued runs + retries deliveries.
- `vercel.json` — `crons: [{ path: "/api/cron/recommendations", schedule: "*/5 * * * *" }]`.

**Board config** (`lib/monday/board-config.ts`):
| Constant | Value |
|----------|-------|
| `RECOMMENDATION_STATUS_COLUMN` | `color_mkzwfy42` |
| `RECOMMENDATION_BUTTON_COLUMN` | `button_mkzw7xx2` |
| `TRAINER_LINK_COLUMN` | `board_relation_mkz4y7tb` |
| `INPLANNEN_GROUP_ID` | `group_mkwtj07a` (verified live) |

---

## 3. Key decisions & divergences from legacy

- **Green-only eligibility.** Legacy allowed Oranje (~33% of legacy recs). M2b requires effective-**green
  for every live theme** and excludes Oranje/Rood/Grijs by design. This is the main expected parity gap.
- **Effective qualification is computed, not membership-read.** A trainer marked groen+rood/oranje does
  not auto-qualify; the same `deriveEffective` + acknowledged-conflict logic as M2a runs on the live
  colour observations.
- **Google Routes API** (`computeRouteMatrix`), not the legacy Distance Matrix API. The field mask includes
  `status` so a failed element can't masquerade as success. `TRAFFIC_UNAWARE`. Address waypoints cap the
  batch at 49 origins/request.
- **Cost-first ranking.** Evaluation scores come from Google Sheets = M3 (not built). Until then
  `themeAvgScore=null` / `overallAvgScore=0`, so ranking is cost↑ then travel↑. The score layers activate
  automatically when M3 lands.
- **Fail-closed, never €0 by accident.** The only €0-travel path is a *confirmed online* training. A
  vague/unknown physical location, an HQ/destination route failure, or a transient failure → FOUT (never
  a cheap-by-mistake GEREED, nothing cached). A per-trainer `ROUTE_NOT_FOUND` or blank address → exclude
  that trainer only.
- **Reproducible, PII-minimized runs.** The stored `input_artifact` makes the deterministic stages
  (eligibility, pricing, ranking) exactly replayable; external AI/Routes outputs are *audited* (recorded),
  not re-executed. No raw addresses anywhere — keyed fingerprints only.

**Parity result** — most recent run (12-training sample): 116 matched + 61 Oranje-excluded (the expected
green-only divergence) + 2 only-legacy pure-groen + 1 only-M2b = **98.3% explained**, 0 FOUT.
`docs/m2a/recommend-parity.md` holds the current numbers and is **regenerated** by `pnpm recommend:parity`
(sample composition shifts as the board changes, so these totals move — never hand-edit that file).

The 3 non-colour diffs *in that particular run* were investigated and traced to legacy row staleness —
written up in `docs/m2a/parity-diff-investigation.md`. That conclusion covers **only those rows**: a
later run's diffs are different rows and must be investigated fresh (the generated report says how).

---

## 3b. Configuring which trainer groups count

Which Monday trainer-board groups feed the recommendations is **configuration, not code**
(fase-2a: *"selecteerbare trainergroepen … niet hardcoded"*). It lives in the `config` table:

| key | value |
|---|---|
| `RECOMMENDABLE_TRAINER_GROUPS` | comma-separated Monday group ids, e.g. `topics,nieuwe_groep__1` |

- An **absent** row falls back to the shipped default (`topics`, `nieuwe_groep__1`).
- A **present but empty** value is rejected — selecting zero groups would make every training return
  GEEN MATCH, a legitimate-looking answer that is really a config error.
- Changes are picked up within **60 s** (config cache TTL); no redeploy needed.

**The change procedure — always run the check:**

```bash
# 1. edit the row
psql … -c "update config set value='topics,nieuwe_groep__1,group_x' \
           where key='RECOMMENDABLE_TRAINER_GROUPS';"
# 2. verify the selection actually does something (exits non-zero if not)
pnpm groups:list
```

`pnpm groups:list` prints every group on the trainer board with a readiness verdict:

| status | meaning | selected → |
|---|---|---|
| `ready` | every green trainer can be priced | fine |
| `partial` | some green trainers have no rate (they'll be skipped as `no_rate`) | warning, exit 0 |
| `not_configured` | no green **and** priceable trainer — selecting it contributes nothing | **exit 1** |
| `missing_from_monday` | the id isn't a group on the board (typo / renamed / deleted) | **exit 1** |

Readiness is deliberately an **intersection**: "5 have a rate" and "4 are green" means nothing if
they're different people, so the number that matters is *green trainers who can actually be priced*.
Rate resolvability is checked against real, date-scoped `rate_cards` (including trainer-scoped
overrides), not merely a non-null `rate_key`.

This **detects** a bad selection; it can't prevent one — a direct DB edit still applies. Hence the
procedure above, and the non-zero exit so it can gate CI. The same data is available to tooling at
`GET /api/config/trainer-groups` (internal ops, `Authorization: Bearer $CONFIG_API_SECRET`). Both
refuse to answer when the Monday snapshot is missing or stale, rather than pairing a fresh board with
stale counts.

> A group with no rate is not fatal at run time either: its trainers are excluded as `no_rate` and the
> training still gets its ranked list from whoever remains.

---

## 4. Run it locally

Local runs use the local Supabase and read live Monday.

> **Re-run `pnpm sync:monday --apply` before the recommend scripts after anything that clears the
> domain tables** — `pnpm db:reset`, and also `pnpm test:integration` (its `truncateDomain` wipes
> trainers/trainings). Otherwise the scripts find nothing: `recommend:once` reports "No Inplannen
> training found", and `recommend:parity` samples 0 trainings and refuses to write a report.
> Note `pnpm sync:monday` **without** `--apply` is a dry run and writes nothing.

### `pnpm recommend:once [mondayItemId] [--apply]`
Runs the full pipeline for one training end-to-end.
- **Dry-run by default** — enqueues, claims, computes, persists, and prints the ranked result, but does
  **not** write Monday (so no FOUT label is required).
- If `GOOGLE_MAPS_API_KEY` / `OPENROUTER_API_KEY` are **absent**, address and travel **stub to online**
  (fee-only) so it runs with just the Monday token. The real providers activate automatically once those
  keys are present.
- With no `mondayItemId`, it picks a training from the Inplannen group.
- `--apply` writes the terminal status to Monday via the scoped writer (needs the FOUT label to exist —
  see §6).

Example output (real live run, training `5029726254`):
```
Providers → address: OpenRouter, travel: Google Routes
Outcome: {"status":"GEREED",...}
Top recommendations (3 shown):
  #1  Lidushka   total €369.03  (fee €352.00, travel €17.03)
  #2  Lennart    total €412.96  ...
  #3  Carlijn    total €474.68  ...
```

### `pnpm groups:list`
Lists every trainer group with its readiness verdict and marks the selected ones. Exits non-zero when a
selected group is unusable. See §3b — run it after every config change.

### `pnpm recommend:parity`
Compares M2b vs the legacy Airtable Aanbevelingen (from `snapshots/airtable/*.json`) across a sample and
writes `docs/m2a/recommend-parity.md`. Categorizes: matched / only-legacy (Oranje-excluded) /
only-legacy (pure groen, unexplained) / only-M2b. Run this before retiring Airtable.

### Test gate
```
pnpm typecheck && pnpm lint
pnpm test:unit           # vitest
pnpm test:integration    # vitest, Docker Supabase
```

---

## 5. Environment variables

| Var | Used by | Notes |
|-----|---------|-------|
| `MONDAY_API_TOKEN` | reads + status writes | Board access token. |
| `MONDAY_WEBHOOK_SIGNING_SECRET` | webhook route | Verifies the Monday signed-JWT `Authorization` header (HS256, exp checked). **Verify Monday actually sends this header for these subscriptions** — otherwise every event 401s. |
| `GOOGLE_MAPS_API_KEY` | travel | Must have the **Routes API** enabled on the key's project *and* allowed in the key's API restrictions (legacy key was Distance-Matrix-only → `403 API_KEY_SERVICE_BLOCKED`). |
| `OPENROUTER_API_KEY` | address cleanup | LLM address formatter (OpenRouter). |
| `CRON_SECRET` | cron route | `Authorization: Bearer $CRON_SECRET`; missing/wrong → 401. Guards the service-role worker (Routes/LLM quota). |
| `SNAPSHOT_MAX_AGE_HOURS` | freshness gate | Optional, default **48**. Snapshot older than this → FOUT `stale_snapshot`. |
| `CONFIG_API_SECRET` | `/api/config/trainer-groups` | Bearer secret for the internal-ops readiness endpoint. Unset ⇒ the endpoint rejects everything (it never opens by default). Not usable from a browser — the Monday iframe view will need its own session-authenticated route. |
| `ADDRESS_HASH_KEY` | travel cache + artifact | HMAC secret for keyed address fingerprints. `travel_cache` keys and audit fingerprints are `HMAC(key, normalized address)` — no raw address is stored. **Required in production** (a prod runtime without it throws → FOUT); dev/test fall back to an insecure constant. |
| `MONDAY_INPLANNEN_GROUP_ID` | routing | Optional override; falls back to `INPLANNEN_GROUP_ID` (`group_mkwtj07a`). |
| `VERCEL_GIT_COMMIT_SHA` | provenance | Auto-set by Vercel; recorded in the artifact. |

Secrets live in **Doppler** (synced to Vercel) and mirror into `.env.local` for local runs. The `.env`
files are agent-blocked — check git tracking, don't read them.

---

## 6. Go-live checklist (ordered)

1. **FOUT label** — add the `FOUT` label to the status column (`color_mkzwfy42`). Requires
   *bordeigenaar* rights. Until it exists, `--apply` / live delivery of a FOUT will fail; dry-run is fine.
   (`GEREED` / `GEEN MATCH` / `RUN` already exist.)
2. **Google Routes API** — enable Routes API on the key's GCP project and add it to the key's API
   restrictions.
3. **Secrets → Doppler** — `MONDAY_API_TOKEN`, `MONDAY_WEBHOOK_SIGNING_SECRET`, `GOOGLE_MAPS_API_KEY`,
   `OPENROUTER_API_KEY`, `CRON_SECRET`, `ADDRESS_HASH_KEY`, `CONFIG_API_SECRET` (+ optional
   `SNAPSHOT_MAX_AGE_HOURS`). They sync to Vercel; changing a secret needs a **redeploy** to take effect.
   `ADDRESS_HASH_KEY` must be a stable random string — rotating it just invalidates the travel cache
   (it rebuilds).
4. **Apply ALL pending migrations** (`supabase db push` / `pnpm db:reset` locally) — do not cherry-pick.
   As of this writing that is 16 files, including the four `2026072812*` ones this feature depends on
   (`RECOMMENDABLE_TRAINER_GROUPS` seed, `read_recommendation_inputs` returning `tr.id`,
   `trainer_group_readiness`, and the RPC grant revocations). Skipping any of them leaves the config row
   or the RPCs missing at runtime. Then commit the regenerated `lib/types/database.gen.ts`
   (`pnpm db:types`).
5. **Deploy to Vercel** — routes are `runtime='nodejs'`, `maxDuration=300`; `/api` self-authenticates
   (excluded from `middleware.ts`). Confirm the `vercel.json` cron is registered.
6. **Register the 2 webhooks** (via the Monday API) — Inplannen group-move + the RUN button status change.
   **Capture the real payloads first** and confirm the Zod field names in `event.ts` are provisional →
   correct, and that a signed `Authorization` header is actually sent.
7. **Verify** — `pnpm groups:list` exits 0 (the configured groups are usable — see §3b); challenge echoes;
   a bad/missing signature → 401; a real move → 200 + a `queued` run that drains to
   `computed`→`delivered`; cron auth (valid `Bearer` → 200, wrong/absent → 401); a live training reaches
   GEREED with real travel; a zero-green training → GEEN MATCH; a vague location → FOUT.

---

## 7. Operate & troubleshoot

**Inspect a run:**
```sql
select id, status, result_status, failing_stage, generation, eligible_count,
       candidate_count, recommendation_count, excluded_trainers, provider_errors,
       input_artifact_hash
from recommendation_runs
where monday_item_id = '<item>'
order by generation desc;
```
`current_recommendations` returns the max-generation run's rows **only if that run is delivered** (a newer
failed run hides an older delivered one — the FOUT state is read from `recommendation_runs`).

**Common failure modes:**
| Symptom | Cause / fix |
|---------|-------------|
| Every webhook 401s | Monday isn't sending the signed `Authorization` JWT, or `MONDAY_WEBHOOK_SIGNING_SECRET` is wrong. Re-capture the payload. |
| `403 API_KEY_SERVICE_BLOCKED` from Routes | Routes API not enabled/allowed on the key — see checklist §2. |
| `FOUT` with `failing_stage=stale_snapshot` | No recent OK `sync:monday`, or snapshot older than `SNAPSHOT_MAX_AGE_HOURS`. Re-run the sync. |
| A group was selected but nothing changed | It's probably `not_configured` — run `pnpm groups:list`. Trainers need both a rate and green theme qualifications before a group contributes anything. |
| Trainers silently missing from results | Check `excluded_trainers` on the run for `no_rate` / `no_address` / `route_not_found`. |
| `groups:list` / the endpoint refuse to report | The Monday snapshot is missing or stale — run `pnpm sync:monday --apply`. They fail loudly rather than pair a fresh board with stale counts. |
| `FOUT` with `invalid_duration` | Training `duur` missing or ≤0. Fix the training in Monday. |
| Delivery never lands | FOUT label missing (write throws), or the delivery lease is held — the cron retries `computed` **and** `failed` runs every 5 min. |
| Runs pile up `queued` | Cron not firing or `CRON_SECRET` mismatch — check the Vercel cron + auth. |

**Concurrency guarantees:** duplicate webhooks dedup on `trigger_uuid`; a superseding re-trigger wins at
persist (generation CAS) and at delivery (lease + fencing), so Monday converges to the latest run's status
even if an older delivery lands last.

---

## 8. Open items / next

- **FOUT label** — blocked on *bordeigenaar* rights.
- **Confirm** the "Aanbevelingen button → RUN" automation exists, and that Monday sends a signed
  `Authorization` header for these subscriptions (else JWT verification 401s everything).
- **M3** — Google-Sheets evaluation import → `trainings.*_snapshot` → activates the score ranking layers.
- **View spec** — Monday iframe item-view reading `current_recommendations` (the sortable list).
- **M2a freshness upgrade** — persist Monday `updated_at`/revision so snapshot freshness is provable.
