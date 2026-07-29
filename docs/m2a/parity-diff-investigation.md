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
