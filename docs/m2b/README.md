# M2b — trainer-recommendation engine (runbook)

> **State: triggered, computed and delivered — beside n8n, not instead of it.**
> A Monday trigger is recorded durably in Redis, published to QStash, computed, and
> written to **our own** status column. n8n keeps `color_mkzwfy42` until our results
> are provably clean. There is still no database and no Aanbevelingen board (§10).

---

## 1. What it does

```
Monday (Aanbevelingen button, or a move into Inplannen)
   └─ webhook → durable trigger record + per-training generation → QStash
        └─ job → read training + roster + qualifications LIVE
                 eligibility (effective-GREEN for EVERY theme)
                 rates (unpriceable trainers dropped BEFORE any provider call)
                 address (OpenRouter) → travel (Google Routes, cache-first) → 5-layer rank
                 record ONE immutable outcome for this generation
                 write GEREED | GEEN MATCH | FOUT to OUR status column
```

**Fail-closed throughout.** A vague location, an unreachable destination or a
transient provider failure is FOUT — never a plausible €0. The only zero-travel path
is a *confirmed* online training.

---

## 2. Architecture map

| Concern | Where |
|---|---|
| Training + qualifications (live) | `lib/recommend/monday-reader.ts` |
| Trainer roster (live, all groups) | `lib/recommend/roster.ts` |
| Eligibility (effective-green) | `lib/recommend/eligibility.ts` + `lib/monday/qualification.ts` |
| Rates, cost, ranking | `lib/calc/*`, `lib/recommend/pricing.ts` |
| Address, travel, cache | `lib/recommend/address.ts`, `travel*.ts` |
| Compute orchestration | `lib/recommend/service.ts` |
| **Key/value primitives** | `lib/recommend/kv.ts` |
| **Durable trigger state** | `lib/recommend/queue-store.ts` |
| **Enqueue + recovery sweep** | `lib/recommend/queue.ts` |
| **Immutable outcomes** | `lib/recommend/outcome.ts` |
| **One job, retryability** | `lib/recommend/job.ts` |
| **Delivery + convergence** | `lib/recommend/deliver.ts` |
| **Dead-letter handling** | `lib/recommend/failure-callback.ts` |
| QStash transport | `lib/recommend/qstash.ts` |

**There is still no database, no migrations, no sync.** Redis holds job state and
caches only. If you find yourself wanting a table, stop — `BRIEFING.md` says to call
Kevin before introducing one.

### Two read boundaries that fail closed on purpose

- **Board schema drift.** `readRoster` and `readAllEffectiveQuals` validate the
  configured columns before decoding. The decoders fail OPEN — a retyped `adres`
  becomes `null` for everyone — so without this check a Monday change would produce a
  perfectly plausible GEEN MATCH.
- **Completeness + coherence.** Both reads pass the board's own `items_count` and
  require `updated_at`, so a short or mid-edit read aborts instead of silently
  returning fewer trainers.

---

## 3. The queue, and what it actually guarantees

Four properties, each preventing a specific failure.

**The Redis record IS the job.** A trigger is written with its generation and indexed
for recovery *before* anything is published, and only marked `published` — and only
then given a 35-minute dedup TTL — once QStash has it. Recording "seen" first would
turn Monday's own retry into a no-op and lose the trigger permanently. A pending
record carries **no expiry**, so durability never depends on something running on a
schedule.

**Ordering is convergence, not exclusion.** Flow Control (`key = training-<itemId>`,
`parallelism: 1`) serializes delivery per training, so unrelated trainings never queue
behind each other. It does **not** make concurrent compute impossible: it bounds what
QStash observes, not what a timed-out function keeps doing. A stale write is therefore
*detected* — the generation is rechecked either side of the write — and repaired.

> Fencing tokens cannot help here. Monday has no conditional write, so no token can
> make it reject a stale one. The Postgres design didn't close this either: its
> advisory lock released at commit, **before** the Monday HTTP call. What made that
> design safe was detect-and-repair, and that is what we ported.

**One immutable outcome per (training, generation).** Compute is not idempotent — it
reads live data and calls paid providers — so every retry, repair and DLQ replay
delivers the *recorded* label instead of recomputing. Outcomes have **no expiry**: DLQ
retention is plan-dependent and can outlive any TTL we would pick.

**Retryability is explicit** (`failure.retryable`, set where the error is raised):

| Outcome | Monday | HTTP | Effect |
|---|---|---|---|
| GEREED / GEEN MATCH | write label | 200 | done |
| Terminal (bad date, duration, unusable location, unreachable destination) | write **FOUT** | **489** + `Upstash-NonRetryable-Error` | no retries, straight to DLQ |
| Transient (provider/infra) | **nothing** | 500 | QStash retries with backoff |
| Compute fine, Monday write failed | — | 500 | retry re-delivers the **stored** label |

Three timeouts, and the order matters:
`runWithDeadline` **270s** < `maxDuration` **300s** < QStash timeout **330s**. A QStash
timeout *below* `maxDuration` would release the Flow Control slot while our function
was still running — manufacturing the overlap the design works to avoid.

**The sweep never gives up.** `/api/cron/publish-pending` republishes stuck triggers,
alerts past a threshold, and keeps retrying on a long interval. An attempt cap would
make a long QStash outage unrecoverable: the highest generation stays pending and
blocks every older generation from writing, so the training ends with no answer at all.

---

## 4. Running beside n8n

- n8n keeps **`color_mkzwfy42`** and still owns the legacy flow.
- We write **`MONDAY_RECOMMENDATION_STATUS_COLUMN`**, a second status column created
  by hand on Agenda 2026 with labels `GEREED` / `GEEN MATCH` / `FOUT`.
- `monday-status.ts` **refuses** to write `color_mkzwfy42`, and `ourStatusColumnId()`
  refuses to accept it as configuration. Both are hard errors — this is what makes the
  side-by-side comparison structurally safe rather than merely intended.
- Trigger routing still watches n8n's column (the `RUN` label and the Aanbevelingen
  button live there), so both systems react to the same planner action.

---

## 5. Key decisions & divergences from legacy

- **Green only.** Since 30 July 2026 ITG's working method is groen/rood; oranje is
  residual. Legacy DID recommend on oranje — those parity differences are expected.
- **`grijs` is "not assessed"**, never a rival colour. Treating it as one silently
  excluded three trainers from ~95 themes each until 2026-08-04.
- **`*NOTK`** (item `2638479433`) is excluded at the roster boundary.
- **Trainer identity is the Monday item id.** Artifact is **v3**; a v2 artifact must be
  refused by any replay tool, not silently re-priced.
- **Rates** are the two cohort defaults (€88 / €84) from `GROUP_POLICY`.
- **Scores are inert** until M3 imports evaluations, so ranking is cost↑ then travel↑.
- **Webhook auth is the URL `?token=`**, not a JWT. Monday only signs webhooks created
  through an integration app, which ITG has not set up; the JWT verifier has been
  removed so there is exactly one gate. Useful side effect: the token is present on the
  setup challenge too, so the route authenticates *before* echoing it.

---

## 6. Configuring which trainer groups count

`RECOMMENDABLE_TRAINER_GROUPS` (env, comma-separated Monday group ids).

- **Absent** → falls back to the `GROUP_POLICY` default (`topics`, `nieuwe_groep__1`).
- **Present but empty** → **rejected**. Clearing it would make every training GEEN
  MATCH, which looks like a legitimate answer.

**Always run `pnpm groups:list` after changing it.** Same report over HTTP:
`GET /api/config/trainer-groups` with `Authorization: Bearer $CONFIG_API_SECRET`.

---

## 7. Commands

| Command | What |
|---|---|
| `pnpm recommend:once <mondayItemId>` | One training end-to-end against live Monday. Read-only. |
| `pnpm groups:list` | Trainer-group readiness; non-zero exit on an unusable selection. |
| `pnpm recommend:parity [--limit=N]` | Compare recommended trainer SETS against the legacy Airtable snapshot. |
| `pnpm replay:verify` | Deterministic replay of `fixtures/replay/`. **Must stay 4/4.** |
| `pnpm test:unit` | Unit tests, in-memory adapters only. |

Full gate:

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm replay:verify && pnpm build
```

**Not covered by unit tests**, deliberately — verify these live after deploy:

1. **Webhook registration + a real event.** Confirm the challenge carries `?token=`,
   and that `triggerUuid` / `triggerKind` look right for a button press and a group move.
2. **The Lua transitions against real Redis.** The in-memory store implements the same
   three transitions in TypeScript, so only a live run exercises the Lua. Fire
   concurrent enqueues for one training: generations must be distinct and increasing,
   and a concurrent `markPublished` + `bumpAttempt` must never yield published-then-pending.
3. **Lost-trigger recovery.** Break `QSTASH_TOKEN`, trigger, confirm a 500 and a pending
   record with `TTL = -1`. Leave it past Monday's 30-minute retry window *and* past the
   sweep's alert threshold, restore the token, and confirm the sweep still publishes it
   with the original generation.
4. **Side-by-side.** Press the button on one real training; both columns move
   independently. Check Monday's activity log to confirm our token never touched
   `color_mkzwfy42`.
5. **Delivery-only failure.** Let compute store `GEREED`, then break the Monday token so
   delivery exhausts its retries ⇒ the failure callback re-delivers **GEREED**, never FOUT.

---

## 8. Environment variables

| Var | Used by | Notes |
|-----|---------|-------|
| `MONDAY_API_TOKEN` | all reads + the status write | |
| `MONDAY_WEBHOOK_TOKEN` | webhook route | The `?token=` shared secret. Unset ⇒ the route rejects everything. |
| `MONDAY_RECOMMENDATION_STATUS_COLUMN` | status write | **Our** column. Refuses `color_mkzwfy42`. |
| `MONDAY_AGENDA_BOARD_ID` | every Agenda read + the status write | **Test override.** Points the whole pipeline at a DUPLICATE of Agenda 2026 (a Monday board copy keeps every column id and group id, so this is the only value that changes). Unset ⇒ production `5087396949`. ⚠️ **Unset it before going live** — while set, the engine never touches ITG's real board, which is a silent no-op rather than a visible failure. `pnpm preflight` prints the board name and warns whenever the override is active. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | queue state, outcomes, travel cache | Set by the Vercel Upstash integration. |
| `QSTASH_TOKEN` | publishing | |
| `QSTASH_URL` | publishing | Only for a REGIONAL account (e.g. `https://qstash-eu-central-1.upstash.io`). Unset ⇒ the global default. Wrong or missing on a regional account ⇒ every publish fails. |
| `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | job + failure routes | Both required; verification is against the raw body and URL. |
| `PUBLIC_BASE_URL` | QStash callbacks | Falls back to `VERCEL_URL`. Set explicitly for local tunnelling. |
| `CRON_SECRET` | `/api/cron/publish-pending` | Unset ⇒ the endpoint rejects everything. |
| `CONFIG_API_SECRET` | `/api/config/trainer-groups` | Unset ⇒ rejects everything. |
| `GOOGLE_MAPS_API_KEY` | travel | Needs the **Routes API** enabled *and* allowed in the key's restrictions. |
| `OPENROUTER_API_KEY` | address cleanup | |
| `ADDRESS_HASH_KEY` | travel cache + artifact | HMAC for keyed fingerprints. **Required in production.** |
| `RECOMMENDABLE_TRAINER_GROUPS` | eligibility | See §6. **Interim home — belongs on the Instellingen board** (§10). |
| `HQ_ADRES`, `TRAVEL_RATE_*`, `TRAVEL_TIME_*`, `THRESHOLD_HOURS` | config | The three **financial** ones are **required in production** — `buildAppConfig` throws rather than defaulting money values. **Interim home** (§10). |
| `LOG_ENABLED` | everything | **Set `true` in production.** `lib/logger` defaults to disabled there, which would silence every alarm below. |
| `LOG_LEVEL` | everything | `info` by default in production; `debug` also shows per-event webhook ignore reasons. |

Secrets live in **Doppler**. `.env*` files are agent-blocked — check git tracking,
don't read them.

---

## 9. Operate & troubleshoot

| Symptom | Cause / fix |
|---|---|
| Nothing happens on a button press | Check the webhook is registered and its URL still carries `?token=`. A 401 is invisible on the board. |
| `FOUT invalid_duration` / `invalid_date` | `duur` missing or ≤0, or a blank date, on a training that HAS themes. Fix the item. |
| `FOUT address` | The location is vague or unresolvable. Never silently €0 — fix `Locatie`. |
| `FOUT travel` | Unreachable destination (terminal) or a Routes outage (retried). The DLQ tells you which. |
| GEEN MATCH that looks wrong | Check `excluded` for `no_rate` / `no_address` / `route_not_found`, then `pnpm groups:list`. |
| **Status stuck on an old label** | The newest generation may still be retrying. Check the QStash DLQ; the failure callback writes the terminal state once retries are exhausted. |
| **`recommendation trigger still unpublished`** | The sweep passed its alert threshold — QStash has been unreachable for a while. It keeps retrying; nothing is parked and no manual requeue is needed. |
| `schema drift on board …` | A configured column was renamed, retyped or repointed. Hard stop by design. |
| `board changed during pagination` | Someone edited the board mid-read. Re-run. |
| `colour conflicts exceed the ceiling` | A trainer×theme in two REAL colours (grijs no longer counts). Acknowledge in `docs/m2a/acknowledgements.json`. |
| Everything silent in production | `LOG_ENABLED` is not `true`. |

---

## 10. Not built yet

- **The Aanbevelingen board.** The status column says only *whether* an answer exists,
  not who was recommended. When it lands, reproduce the old `current_recommendations`
  rule: it went empty whenever the max-generation run was not delivered, so a newer
  in-flight run hid an older result rather than showing stale rows.
- **A per-generation compute lease.** Two deliveries can both compute before either wins
  the `SET NX`, so duplicate provider charges are possible when execution exceeds the
  QStash timeout. Accepted as a rare cost; the lease is the fix if it shows up in billing.
- **The Instellingen board — the next pass.** Travel rates, the travel-time fee, the
  thresholds and `RECOMMENDABLE_TRAINER_GROUPS` currently live in **env**, which is the
  wrong home: `docs/build/03-aanbevelingsengine.md` says "Alle bedragen en drempels
  komen uit het Instellingen-board, nooit uit de code", and the groups setting *is* the
  fase-2a deliverable "selecteerbare trainergroepen". Today ITG cannot change any of
  them without a developer and a redeploy. The move is cheap because `buildAppConfig`
  already takes generic key/value rows — only their source changes — but the reader
  must keep the same fail-closed rule: a missing financial row in production is an
  error, never a default. Config is rates and group ids, no PII, so a short Redis cache
  is fine here (unlike the roster).
- **Reconciliation sweep** for Inplannen trainings whose status is stale or blank. The
  `publish-pending` cron is its natural home.
- **A "Herbereken" trigger of our own.** Today the manual path is n8n's Aanbevelingen
  button, which sets `RUN` on `color_mkzwfy42` — so we are piggybacking on the legacy
  column and would lose our trigger the day it is retired. The clean version is a `RUN`
  label on OUR status column plus a Herbereken button that sets it, exactly the pattern
  `color_mkzwfy42` already uses. The loop guard already covers it: only `RUN` triggers,
  and the writer can never emit `RUN`. During side-by-side `webhookRouting` should watch
  BOTH columns — n8n's so one press exercises both systems on the same training, ours so
  a recompute does not also kick off the legacy flow.
- **Retrigger on plain column edits.** Editing `duur` or `Locatie` fires no webhook, so
  an answer can silently go stale — and nothing on the board shows how old an answer is.
  A "Laatste berekening" date column written beside the status would at least make that
  visible. `mondayItemRevision` is already captured and could drive an `updated_at` check.
- **Roster/qualification caching.** Deliberately NOT added: it would put trainer names
  and raw addresses into Upstash, which the travel cache explicitly avoids. Revisit only
  with a minimized or encrypted representation and a documented retention decision.
- Removing n8n — only once ours is provably clean.

### Still blocked on ITG

- SharePoint app registration (`Sites.Selected`) — the project's biggest risk, and not
  needed for recommendations at all.
- Per-trainer `Uurtarief` on the trainers board.
