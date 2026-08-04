# M2b — trainer-recommendation engine (runbook)

> **State as of 2026-08-04: compute only, no database, nothing writes to Monday.**
> Supabase was removed in the "strip pass" (see `docs/build/10-architectuurreview.md`
> and `docs/build/BRIEFING.md`). The engine reads Monday live, computes, and returns
> the answer. The durable queue, the Aanbevelingen board and the status write-back
> are the NEXT pass — see §8.

---

## 1. What it does

```
mondayItemId
   ├─ read the training LIVE from Monday (themes, date, duration, locatie, updated_at)
   ├─ read the full trainer roster LIVE (all groups) — once per execution
   ├─ read the training's theme qualifications LIVE (4 colour relations)
   ├─ eligibility: effective-GREEN for EVERY theme of the training
   ├─ rates: drop unpriceable trainers as `no_rate` BEFORE any provider call
   ├─ address (OpenRouter) → travel (Google Routes, cache-first) → cost → 5-layer rank
   └─ return RecommendationResult (GEREED | GEEN MATCH | FOUT)
```

**Fail-closed throughout.** A vague location, an unreachable destination or a
transient provider failure is FOUT — never a plausible €0. The only zero-travel path
is a *confirmed* online training.

`runRecommendation(deps, mondayItemId)` returns a discriminated union: success
carries the ranked list plus full provenance; failure carries `failure.stage` plus
whatever provenance existed when it stopped. Nothing is persisted.

---

## 2. Architecture map

| Concern | Where |
|---|---|
| Training + qualifications (live) | `lib/recommend/monday-reader.ts` |
| Trainer roster (live, all groups) | `lib/recommend/roster.ts` |
| All qualifications, whole board | `lib/recommend/qualifications.ts` |
| Eligibility (effective-green) | `lib/recommend/eligibility.ts` + `lib/monday` qualification derivation |
| Rates, cost, ranking | `lib/calc/*`, `lib/recommend/pricing.ts` |
| Address cleanup | `lib/recommend/address.ts` + `completion.ts` |
| Travel + cache | `lib/recommend/travel*.ts` |
| Audit artifact (v3) | `lib/recommend/artifact.ts` |
| Orchestration | `lib/recommend/service.ts` |
| Config (from env) | `lib/recommend/engine-config.ts` + `lib/config/` |
| Webhook parse + handler | `lib/recommend/event.ts`, `webhook.ts` |

**There is no database, no migrations, no sync.** If you find yourself wanting a
table, stop — `BRIEFING.md` says to call Kevin before introducing one.

### Two boundaries that fail closed on purpose

- **Board schema drift.** `readRoster` and `readAllEffectiveQuals` validate the
  configured columns (`assertColumns`) before decoding. The decoders fail OPEN — a
  retyped `adres` column becomes `null` for everyone, a missing colour relation
  becomes an empty array — so without this check a Monday change would produce a
  perfectly plausible GEEN MATCH.
- **Completeness + coherence.** Both reads pass the board's own `items_count` and
  require `updated_at`, so a short or mid-edit read aborts instead of silently
  returning fewer trainers.

---

## 3. Key decisions & divergences from legacy

- **Green only.** A trainer must be effective-**green** for every theme. Since
  30 July 2026 ITG's working method is groen/rood; oranje is residual data.
  Legacy DID recommend on oranje — those parity differences are expected, not bugs.
- **`grijs` is "not assessed"**, never a rival colour. A trainer listed both grijs
  and groen is GREEN. Treating grijs as a conflict silently excluded three trainers
  from ~95 themes each until 2026-08-04.
- **`*NOTK`** (item `2638479433`) is excluded at the roster boundary — it is a
  placeholder, not a person, and it *is* linked from real trainings.
- **Trainer identity is the Monday item id.** There is no internal uuid;
  `RateCard.trainerId` keys on the same id. Artifact is **v3**; a v2 artifact must be
  refused by any replay tool, not silently re-priced.
- **Rates** are the two cohort defaults (€88 / €84) derived from `GROUP_POLICY`.
  Per-trainer `Uurtarief` becomes a trainer-scoped card once ITG fills that field —
  the mechanism already works.
- **Scores are inert** until M3 imports evaluations, so ranking is cost↑ then travel↑.

---

## 3b. Configuring which trainer groups count

`RECOMMENDABLE_TRAINER_GROUPS` (env, comma-separated Monday group ids).

- **Absent** → falls back to the `GROUP_POLICY` default (`topics`, `nieuwe_groep__1`).
- **Present but empty** → **rejected**. Clearing it is a loud error, not a silent
  fallback: selecting zero groups would make every training GEEN MATCH, which looks
  like a legitimate answer.

**Always run `pnpm groups:list` after changing it.** It reports every group on the
board with a readiness verdict and exits non-zero when a *selected* group is
`missing_from_monday` (typo/renamed/deleted) or `not_configured` (nobody green, or
nobody priceable). `partial` warns but passes — those trainers are skipped as
`no_rate`.

Same report over HTTP: `GET /api/config/trainer-groups` with
`Authorization: Bearer $CONFIG_API_SECRET`.

---

## 4. Run it locally

Needs only `.env.local`. **No Docker, no database.**

| Command | What |
|---|---|
| `pnpm recommend:once <mondayItemId>` | One training end-to-end against live Monday. Read-only — prints the ranked list, writes nothing. |
| `pnpm groups:list` | Trainer-group readiness from live data; non-zero exit on an unusable selection. |
| `pnpm recommend:parity [--limit=N]` | Compares recommended trainer SETS against the legacy Airtable snapshot, in-process, roster loaded once. Writes `docs/m2a/recommend-parity.md`. |
| `pnpm replay:verify` | Replays `fixtures/replay/` through the engine and diffs the whole result against the recorded baseline. Deterministic, no network. |
| `pnpm test:unit` | 36 files. There are no integration tests — the DB they needed is gone. |

**`replay:verify` vs `recommend:parity`** — they answer different questions and both
matter. Replay is deterministic (every input pinned, including provider responses)
and proves the plumbing did not change. Parity is live and drifting: it exercises the
real roster adapter and shows how we currently differ from legacy Airtable.

---

## 5. Environment variables

| Var | Used by | Notes |
|-----|---------|-------|
| `MONDAY_API_TOKEN` | all reads | Board access token. |
| `MONDAY_WEBHOOK_SIGNING_SECRET` | webhook route (next pass) | Verifies Monday's signed JWT. Unverified against a real payload. |
| `GOOGLE_MAPS_API_KEY` | travel | Needs the **Routes API** enabled *and* allowed in the key's restrictions. |
| `OPENROUTER_API_KEY` | address cleanup | |
| `ADDRESS_HASH_KEY` | travel cache + artifact | HMAC for keyed address fingerprints — no raw address is stored. **Required in production**; dev falls back to an insecure constant. |
| `CONFIG_API_SECRET` | `/api/config/trainer-groups` | Unset ⇒ the endpoint rejects everything. |
| `RECOMMENDABLE_TRAINER_GROUPS` | eligibility | See §3b. |
| `HQ_ADRES`, `TRAVEL_RATE_TRAINER_CENTS_PER_KM`, `TRAVEL_RATE_CLIENT_CENTS_PER_KM`, `TRAVEL_TIME_THRESHOLD_MINUTES`, `TRAVEL_TIME_MODE`, `TRAVEL_TIME_FEE_PER_MINUTE_CENTS`, `THRESHOLD_HOURS` | config | The three **financial** ones are **required in production** — `buildAppConfig` throws rather than defaulting money values. |
| `LOG_ENABLED` | everything | **Set `true` in production.** `lib/logger` defaults to disabled there, which would silence every alarm below. |
| `LOG_LEVEL` | everything | `info` by default in production; `debug` also shows per-event webhook ignore reasons. |
| `VERCEL_GIT_COMMIT_SHA` | provenance | Auto-set by Vercel. |

Secrets live in **Doppler**. `.env*` files are agent-blocked — check git tracking,
don't read them.

---

## 6. Operate & troubleshoot

| Symptom | Cause / fix |
|---|---|
| `FOUT invalid_duration` / `invalid_date` | Training `duur` missing or ≤0, or a blank date, on a training that HAS themes. Fix the item in Monday. |
| `FOUT address` | The location is vague or unresolvable. Never silently €0 — fix `Locatie`. |
| `FOUT travel` | Transient Routes failure or an unreachable destination. Retry; if persistent, check the Routes API key. |
| GEEN MATCH that looks wrong | Check `excluded` for `no_rate` / `no_address` / `route_not_found`, then `pnpm groups:list`. |
| **`schema drift on board …`** | A configured Monday column was renamed, retyped or repointed. This is a hard stop by design — fix the board or update `board-config.ts`. |
| `board changed during pagination` | Someone edited the board mid-read. Re-run. |
| `colour conflicts exceed the ceiling` | A trainer×theme in two REAL colours (grijs no longer counts). Acknowledge in `docs/m2a/acknowledgements.json`. |
| Everything silent in production | `LOG_ENABLED` is not `true`. |

---

## 7. Verification gate

```
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm replay:verify && pnpm build
```

`replay:verify` must report **4/4 match**. It compares the complete normalized
result and artifact — status, counts, exclusions, address decision, provenance,
ranked rows, qualification observations, effective values, rate inputs, enrichment
and route fingerprints — stripping only the four intentional differences (artifact
version, trainer identity, `inputSyncRunId`, hash).

---

## 8. Deferred to the next pass (NOT built)

Be explicit with anyone reading this: **the engine cannot yet be triggered or
deliver an answer by itself.**

- **KV `RunQueue`** — webhook dedup, per-training generation, delivery lease and
  fencing. All need an atomic compare-and-swap; `RunQueue` is a port with no
  implementation, and `webhook.ts` is wired to it but has no route.
- **The webhook and cron routes** were deleted with the queue; they return next pass.
- **The Aanbevelingen board** — where the ranked list will live between planning and
  the planner's confirmation.
- **Our own status column** on Agenda 2026, so this runs BESIDE n8n rather than
  replacing it. n8n keeps `color_mkzwfy42` until we are provably clean.
- **Shared travel cache** — currently in-process only, so it is empty on a cold start.
- Stats layer, WhatsApp text, trainerbevestiging, daily controle cron.

### Still blocked on ITG

- `FOUT` label on the status column (needs bordeigenaar) — only relevant once we
  write status.
- SharePoint app registration (`Sites.Selected`) — the project's biggest risk, and
  not needed for recommendations at all.
- Per-trainer `Uurtarief` on the trainers board.
