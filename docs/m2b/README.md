# M2b — trainer-recommendation engine (runbook)

> **State: triggered, computed and delivered — beside n8n, not instead of it.**
> A Monday trigger is recorded durably in Redis, published to QStash, computed, and
> written to **our own** status column. n8n keeps `color_mkzwfy42` until our results
> are provably clean. There is still no database and no Aanbevelingen board (§10).

---

## 1. What it does

```
Monday (a move into Inplannen OR Herplannen / Inplannen)
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

**One immutable outcome per (training, generation), in three keys.** Compute is not
idempotent — it reads live data and calls paid providers — so every retry, repair and DLQ
replay delivers the *recorded* answer instead of recomputing.

| key | contents | expiry |
|---|---|---|
| `result:<item>:<gen>` | the label | **none** |
| `rows:<item>:<gen>` | the ranked list, or the failure stage | **12 months** |
| `completed-gen:<item>` | highest generation that produced a label | none |
| `whatsapp:<item>` | the planner's edited WhatsApp message, or a tombstone | **90 days** |
| `city:v2:<address fingerprint>` | the town the address step resolved | **180 days** |
| `board-of:<item>` | which board an item is on, for mutation authorization | **10 minutes** |

The **label** never expires. The pending sweep retries a stuck trigger indefinitely
(§3 above), so the replay horizon is unbounded — not the DLQ's 30-day/3-month retention.
A label that lapsed would let a recovered repair recompute an already-delivered answer.

The **WhatsApp message is the one free-text value in Redis**, and that is a deliberate
exception to an otherwise firm rule — everything else here is ids and numbers, so a breach
of the store yields opaque identifiers rather than readable content. The record holds the
generated message (klant, locatie, deelnemersaantal — all already visible to anyone who
can open the board) plus whatever a planner typed into it, which is why the panel says in
so many words not to put personal data there. It is keyed on the TRAINING, not the
generation: a recalculate must not throw away somebody's note. **Reading it requires
`plan`, not `view`** — see §8.

Concurrency on that key is compare-and-set against `sha1(stored bytes)`, with a tombstone
on delete. Two properties are load-bearing: a hash of raw bytes still identifies a record
nobody can *parse*, so an unreadable value can be overwritten or discarded rather than
being stuck; and it has no ABA hole, where a revision counter restarting after a delete
would let a delayed write match a brand-new record. A mismatch whose content is identical
is reported as success, because that is a lost response, not a colleague.

The **city** is cached against the ADDRESS, never frozen onto a generation. Freeze it and
a planner who edits `Locatie` without recalculating keeps the old town, with nothing to
mark it stale; keyed on the address, a changed location is a changed key and the message
falls back to the raw text. `v2` in the key is the address prompt version, so a bad model
vintage is abandoned wholesale by bumping it. Note that a `no_match` training normally has
**no** city at all — the engine skips address classification when nothing is priceable
(`service.ts`), so those show the raw `Locatie` text. Accepted, not overlooked.

The **rows** do expire: they are performance and rate data about identifiable trainers,
so keeping them forever should be a decision, not a side effect. Twelve months is 4× the
longest DLQ tier.

All three are written by **one Lua script** (`outcome.ts`). Two calls could crash in
between, and `runJob` short-circuits on the label, so the missing rows would never be
repaired — a delivered answer whose list was silently lost. `createOutcomeStore` keeps a
TypeScript twin of the same rules for the in-memory tests, exactly as `queue-store.ts`
does; production must use `createUpstashOutcomeStore`.

The **watermark** is what stops an expired list from reading as "still computing":
generation `G` with no label is `computing` when the watermark is `< G`, `unavailable`
when `>= G`. One integer per training, so it cannot grow without bound. A value that is
not a non-negative integer **throws on both paths** rather than defaulting — `NaN` is
neither `< G` nor `>= G`, and 0 would resurrect the permanent spinner it exists to
prevent.

The rows are validated against a discriminated union **on write as well as on read**:
`ready` must carry at least one row (the engine emits GEREED only when `ranked.length >
0`), `failed` must carry a stage and no rows, cents must be whole and non-negative.
Read-side validation alone would not be enough — the label is permanent and `runJob`
short-circuits on it, so a bad detail written beside a good label could never be
repaired. Both preconditions, the detail and the watermark, are checked **before the
first key is written**: a Redis script is atomic but does not roll back the writes it
made before erroring, so a late check would strand a permanent label on a failed claim.
A rejected claim leaves all three keys absent and is safe to retry.

**Legacy records** — written before the split — are bare label strings under the same
`result:` key, so every delivery path reads them unchanged. They simply have no rows.

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

The **`TRAINERGROEPEN` row on the Instellingen board**, chosen in its `Groepen` dropdown.
The board is the only source: `RECOMMENDABLE_TRAINER_GROUPS` is no longer read at all.

- **Row absent** → the read is **refused** (`assertRequiredKeys`), like any other missing
  board row. There is no environment fallback and no code default.
- **Row present, nothing selected** → refused with its own message, because "create the
  row" and "fill it in" are different instructions for whoever is looking at the board.
- **The `Groepen` column deleted** → refused by `SETTINGS_ENGINE_COLUMNS`. Monday omits an
  id it does not recognise, so without that assertion a deleted column reads exactly like
  an empty selection.

Historic behaviour of the env variable, kept for reading older builds:

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
| `pnpm test:routes` | The recommendation routes over real HTTP. Starts its own server on **3111** with pinned auth config, so it neither touches nor depends on a dev server on 3000. Needs Redis + `MONDAY_API_TOKEN`; **fails rather than skips when `CI` is set**, because a green run that exercised no route is worse than a red one. |

Full gate:

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:routes && pnpm replay:verify && pnpm build
```

`test:routes` is **not optional**. It is the only thing that runs the authorization
wiring — every capability decision below is a unit test of a pure function until an
actual request goes through a route file.

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
6. **The WhatsApp CAS script.** Same gap as (2): the twin implements the rules in
   TypeScript, so only a live run exercises `redis.sha1hex`. Use
   `pnpm view:smoke <itemId> --mutate` **against a preview deployment whose
   `MONDAY_AGENDA_BOARD_ID` points at the TEST board**. Production would refuse a
   TEST-board item anyway, and snapshot-and-restore against a real Agenda item is not an
   option either — the restore would clobber a concurrent planner's save.
7. **The clipboard inside Monday's iframe.** `navigator.clipboard.writeText` needs the
   host to grant `clipboard-write`, which Monday controls. Press **Kopieer** in the real
   iframe and note which of the three fallbacks runs; no test here can tell you.

---

## 8. Environment variables

| Var | Used by | Notes |
|-----|---------|-------|
| `MONDAY_API_TOKEN` | all reads + the status write | |
| `MONDAY_WEBHOOK_TOKEN` | webhook route | The `?token=` shared secret. Unset ⇒ the route rejects everything. |
| `MONDAY_RECOMMENDATION_STATUS_COLUMN` | status write | **Our** column. Refuses `color_mkzwfy42`. |
| `MONDAY_TRIGGER_GROUP_IDS` | webhook routing + `webhook:register` | **Comma-separated** group ids whose arrival triggers a run, and it **REPLACES the defaults rather than adding to them** — the singular name is a leftover, so setting one id silently unsubscribes the other group. Unset ⇒ both `group_mkwtj07a` (*Inplannen*) and `nieuwe_groep` (*Herplannen / Inplannen*). Blank entries are dropped and an all-blank value falls back — an empty id would match no group, so every trigger would be ignored behind a healthy 200. Run `pnpm columns:list` after changing it: it marks the resolved trigger groups and warns about ids absent from the board. |
| `MONDAY_AGENDA_BOARD_ID` | every Agenda read + the status write | **Test override.** Points the whole pipeline at a DUPLICATE of Agenda 2026 (a Monday board copy keeps every column id and group id, so this is the only value that changes). Unset ⇒ production `5087396949`. ⚠️ **Unset it before going live** — while set, the engine never touches ITG's real board, which is a silent no-op rather than a visible failure. `pnpm preflight` prints the board name and warns whenever the override is active. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | queue state, outcomes, travel cache | Set by the Vercel Upstash integration. |
| `QSTASH_TOKEN` | publishing | |
| `QSTASH_URL` | publishing | Only for a REGIONAL account (e.g. `https://qstash-eu-central-1.upstash.io`). Unset ⇒ the global default. Wrong or missing on a regional account ⇒ every publish fails. |
| `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | job + failure routes | Both required; verification is against the raw body and URL. |
| `PUBLIC_BASE_URL` | QStash callbacks | Falls back to `VERCEL_URL`. Set explicitly for local tunnelling. |
| `MONDAY_APP_CLIENT_SECRET` | the item view's four routes | The Monday app's client secret; every `sessionToken` is verified against it, HS256 only. Unset ⇒ those routes answer **503**, not 500 — the feature is not configured, which is a deployment state with an obvious fix rather than a crash. |
| `MONDAY_ACCOUNT_ID` | the item view's four routes | ITG's account. A validly signed token from any other account is refused. No default: "any account" is not a safe fallback. |
| `MONDAY_RECOMMENDATION_DEFAULT_CAPS` | the item view's four routes | What **every verified member of ITG's account** gets: a comma-separated list of `view`, `plan`, `full`. ITG's decision (6-Aug-2026) is no gating, so production is `view,plan,full` and the map below stays empty. ⚠️ **Account-wide is wider than board-wide.** A session token names the account and the user, never which boards they can open — so this reaches anyone in the account, including someone with no access to Agenda 2026. Monday's own permissions still govern the *pick* (a client-side write as that user); they do not govern our read. **Unset ⇒ nobody has access**, so an empty configuration denies rather than exposes rates. |
| `MONDAY_API_TOKEN` | …and the item view's **mutating** routes, plus the WhatsApp route | Used for the board check, and by the WhatsApp route for the one column read that builds the message. Built lazily, so a missing or rotated token stops new work being queued but does **not** take the view down — the stored list is served entirely from Redis. |
| `MONDAY_RECOMMENDATION_CAPS` | the item view's four routes | Per-user overrides, only needed to give **more** than the default: `userId:caps; userId:caps`, e.g. `222:plan; 333:full`. Unions with the default — a listed entry can never take a capability away. Malformed input throws on the first request rather than silently denying: a typo like `veiw` would otherwise look exactly like a permissions bug. A user who ends up with `plan`/`full` but no `view` is rejected too, since they could not open the list to use either. |
| `CRON_SECRET` | `/api/cron/publish-pending` | Unset ⇒ the endpoint rejects everything. |
| `CONFIG_API_SECRET` | `/api/config/trainer-groups` | Unset ⇒ rejects everything. |
| `GOOGLE_MAPS_API_KEY` | travel | Needs the **Routes API** enabled *and* allowed in the key's restrictions. |
| `OPENROUTER_API_KEY` | address cleanup | |
| `ADDRESS_HASH_KEY` | travel cache + artifact | HMAC for keyed fingerprints. **Required in production.** |
| `RECOMMENDABLE_TRAINER_GROUPS` | — | **Rollback-only, and no longer read.** The `TRAINERGROEPEN` row on the Instellingen board is the sole source (§6); this variable is not consulted even as a fallback. Keep it configured until the cutover is proven stable — a Vercel code rollback lands on a build that still needs it — then delete it as its own deliberate step. |
| `HQ_ADRES`, `TRAVEL_RATE_*`, `TRAVEL_TIME_THRESHOLD_MINUTES`, `TRAVEL_TIME_FEE_PER_MINUTE_CENTS` | — | **Rollback-only.** These now come from the **Instellingen board** (5102171946): `HQ ADRES`, `REISTARIEF TRAINERS`, `REISTARIEF HQ`, `REISTIJD DREMPEL`, `REISTIJD VERGOEDING`. **Do not delete them yet** — a Vercel code rollback does not restore deleted variables, and the previous build's `buildAppConfig` throws when the financial ones are absent. Remove them as a deliberate step once the cutover is stable. |
| `TRAVEL_TIME_MODE`, `THRESHOLD_HOURS` | config | **Still env, permanently.** Deliberately kept OFF the board — `hourly_rate` throws in `travelTimeCompensation`, and `THRESHOLD_HOURS` is read by nothing yet, so an editable knob would be a trap. `buildSettingsSnapshot` injects them from env as `OFF_BOARD_KEYS`: "not ITG-editable" is not "not configured". |
| `MONDAY_INSTELLINGEN_BOARD_ID`, `MONDAY_INSTELLINGEN_NOTITIES_GROUP_ID` | settings | **Preview and local ONLY.** Production reads the pinned constant, and setting either in production makes the app refuse to boot rather than quietly prefer one of two values. They travel as a pair — Monday generates the Notities group id per board. |
| `LOG_ENABLED` | everything | **Set `true` in production.** `lib/logger` defaults to disabled there, which would silence every alarm below. |
| `LOG_LEVEL` | everything | `info` by default in production; `debug` also shows per-event webhook ignore reasons. |

Secrets live in **Doppler**. `.env*` files are agent-blocked — check git tracking,
don't read them.

---

### Who may read the WhatsApp message

The message route (`GET|PUT|DELETE /api/recommendations/[itemId]/whatsapp`) requires
**`plan`**, not `view` — the only endpoint in the feature that does. Two reasons, stated
so the narrowing is a decision rather than an accident:

- the payload carries klant, locatie, deelnemersaantal and **arbitrary planner-typed
  text**, where the main envelope carries ids and numbers;
- capability is account-wide and board-blind (see `MONDAY_RECOMMENDATION_DEFAULT_CAPS`
  above), so `view` can reach somebody who cannot open Agenda 2026 at all.

It introduces **no new boundary**: `PUT approached` already writes account-wide shared
state keyed only by item id for `plan` holders. What it adds is free text, and the panel
tells the planner not to put personal data in it.

Every mutation verifies the item's board independently, via `board-of:<item>` with a cold
`ItemBoardReader` lookup behind it. The CAS token is a concurrency device, not an
authorization one — `absent` is guessable — so without that check a `plan` holder could
write records against arbitrary item ids.

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
- **The Instellingen board — DONE (fase 1 + 2a).** Travel rates, the travel-time fee, the
  thresholds and the trainer-group selection now all live on board `5102171946`, and ITG
  edits them without a developer or a redeploy. Kept here as the record of why it was
  worth doing: `docs/build/03-aanbevelingsengine.md` says "Alle bedragen en drempels komen
  uit het Instellingen-board, nooit uit de code", and the groups setting *is* the fase-2a
  deliverable "selecteerbare trainergroepen". The move was cheap because `buildAppConfig`
  already took generic key/value rows — only their source changed — and the reader kept
  the same fail-closed rule throughout: a missing row is an error, never a default. Config
  is rates and group ids, no PII, so the short Redis cache is fine here (unlike the
  roster). Still open: `PLANNING GROEPEN` (the trigger groups, next bullet) and the
  Schaduwpool unlock, which needs options appended to the live `Groepen` dropdown.
- **Trigger groups on the Instellingen board — read this before moving them there.**
  `MONDAY_TRIGGER_GROUP_IDS` looks like ordinary config, but it is only *half* of a
  subscription. Monday delivers `item_moved_to_specific_group` **only for groups a
  webhook was explicitly registered for**, so adding a group to a settings board would
  change routing and change nothing observable: no webhook, no event, no run — and no
  error either. That is the same silent shape as a mistyped group id.

  Two ways out, and they should be decided together, not one at a time:

  1. **Subscribe to `item_moved_to_group`** (every group move on the board, no config)
     and keep filtering in `parseWebhook`. Configuration then genuinely is
     configuration — one webhook, forever, and adding a group in Instellingen just
     works. Cost: we receive every group move on Agenda 2026, including planners
     shuffling items between month groups, each an ignored 200. Cheap per event, but
     it is real traffic and worth measuring before committing.
  2. **Keep per-group webhooks and reconcile them** — the app, or a command, diffs
     configured groups against registered webhooks and creates/deletes the difference.
     Keeps event volume minimal, but it means something automatically mutates Monday
     webhooks, which today is deliberately a hand-run operator action.

  Whichever is chosen, `pnpm columns:list` already marks the resolved trigger groups
  and warns about ids that are not on the board — the cheap half of the safety net.
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
