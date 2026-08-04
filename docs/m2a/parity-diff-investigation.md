# Parity diff investigations

Hand-written log of investigated M2b-vs-legacy parity differences. **Never regenerated** — unlike
`recommend-parity.md`, which `pnpm recommend:parity` overwrites on every run.

Each entry is tied to the exact rows it examined. A conclusion here applies **only** to those
trainer × training pairs on that date; it does not certify any later run. When a new report shows a
`pure-groen` or `only-M2b` diff, investigate it fresh (the generated report explains how) and add an
entry.

---

## 2026-07-28 — the 3 non-colour diffs in the 12-training sample

**Context.** Airtable was re-pulled **live** first (454 → 607 rows, +153 added, 0 removed — the legacy
n8n flow is still running), so both sides were current. The same 3 diffs persisted, ruling out a stale
snapshot file as the cause.

**Rows examined**

| Training | Trainer | Legacy row (`Created`) | Live Monday colours | M2b | Verdict |
|---|---|---|---|---|---|
| `2888847170` | Annemiek Bruin (`1661151229`) | `Groen` (2026-07-07 08:39) | **groen + rood** | excluded (conflict → effective `null`) | M2b correct |
| `2888847170` | Gert Contant (`1661151135`) | *(absent)* | groen | included | M2b correct |
| `3032386245` | Gert Contant (`1661151135`) | `Groen` (2026-07-07 13:14) | **rood** | excluded (effective `red`) | M2b correct |

**Conclusion (for these rows only).** All three are explained by qualification edits made on Monday
*after* 2026-07-07, when those legacy rows were written. Legacy Aanbevelingen is append-only history
(`Created` spans 2026-03-12 → 2026-07-28; zero rows ever removed) and is never recomputed, so its rows
describe the board at generation time while M2b live-reads qualifications on every run.

The Gert Contant pair is the clearest evidence: the *same* trainer is green for *Lichaamstaal*
(training `2888847170`) and rood for *Prioriteiten en planning* (training `3032386245`) — qualifications
are per trainer × theme, and each was edited independently. A systematic engine fault would not produce
diffs in opposite directions for one person on the same day.

**Not tested:** whether the legacy flow, re-run today, would also detect Annemiek's simultaneous
groen+rood membership. Only its stored output was inspected, and that simply reads `Groen`.

---

## 2026-08-04 — after the Supabase strip (live reads)

Re-ran `pnpm recommend:parity --limit=8` against live Monday with no database.
Raw counts looked alarming next to the July run: **21 "unexplained"** (was 2) and
**33 only-M2b** (was 1).

**Investigated, not assumed.** Traced training `3084042054` trainer-by-trainer
against the live board. **All six** only-legacy trainers there carry legacy
`Qualification = "Groen"` but are **`rood` on the live board today** for theme
`5072549197`. Every one is present in the roster, in a selected group, with a
resolvable rate — so they are excluded at eligibility, correctly.

(Individuals are deliberately not named here. This file is committed, and a
qualification colour is a competence judgement about a named contractor; the
training id + theme id above are what make the finding reproducible. Re-run
`pnpm recommend:parity` and inspect the live board if you need the names.)

**Mechanism (the same one as the July finding, at larger scale):** Airtable
Aanbevelingen is an append-only log; rows are never recomputed. ITG switched to a
groen/rood working method on 30 July 2026 and has been re-qualifying in bulk —
qualification observations went 3555 → 4620 in a single day on 4 August. The legacy
rows record a board that no longer exists.

**Fix applied to the harness, not to the engine.** `recommend-parity.ts` now
classifies an only-legacy trainer against the LIVE effective qualification rather
than the frozen legacy string, adding a `requalified` bucket. Re-running:

```
matched 63, oranje-excluded 32, requalified 21, unexplained 0, only-m2b 33, fout 0
```

**All 21 were requalified. Zero genuinely unexplained.** `unexplained` now means
what it says — green then AND green now, yet missing from our result — and is the
only bucket that should be read as a defect.

**only-M2b 33 is NOT explained.** An earlier draft of this note called it "the
mirror image" of `requalified`. That was an overreach and is withdrawn: an only-M2b
row proves only that **no legacy row exists**, which is not the same as "legacy would
have recommended them but for their colour". Legacy could have omitted a trainer for
a group, rate, route or workflow reason, and Airtable does not record *why* a trainer
was left out — so the data needed to close this bucket does not exist in the snapshot.

4 of the 33 were spot-checked on `3084042054`. One of them is among the three
trainers the grijs fix restored the same day — groen+grijs, which the old conflict
rule treated as unresolvable. That explains *those* rows and nothing else.

**These 33 stay in the review bucket.** Closing them means either sampling them
against the live board one by one, or accepting that legacy's omission reasons are
unrecoverable and saying so explicitly. Until then, do not read this report as
"parity verified" — read it as "no only-legacy discrepancy remains, only-M2b
outstanding".

**Caveat:** this is an 8-training sample of a live, moving board, and it is not a
regression gate. `pnpm replay:verify` is the deterministic check; parity shows
current drift versus legacy.
