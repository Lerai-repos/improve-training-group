# Improve Training Group — trainer recommendation engine

Backend for ITG's trainer planning. Given a training on their Monday board, it works
out which trainers are qualified, what each would cost, and ranks them.

**Monday is the source of truth. There is no database.** Everything is read live from
the Monday API at request time; the backend is stateless. That is a deliberate
architecture decision (3 August 2026) — see `docs/build/BRIEFING.md` and
`docs/build/10-architectuurreview.md`. If you find yourself wanting a table, stop and
ask first.

The operational reference is **[`docs/m2b/README.md`](docs/m2b/README.md)** — flow,
environment variables, troubleshooting, and what is deliberately not built yet.

---

## Current state

**Compute only.** The engine reads Monday, computes, and returns the answer. It is
not yet triggered by anything and writes nothing back:

- no durable queue (the webhook and cron routes are deferred with it)
- no Aanbevelingen board
- no status write-back — n8n still owns that column

See `docs/m2b/README.md` §8 for the deferred list.

---

## Stack

- **Next.js 15** (App Router, Turbopack) — API routes only; there is no UI yet
- **TypeScript**, **Vitest**, **Prettier**, **ESLint**
- **Monday GraphQL API** — pinned version, mandatory `BoardRelationValue` /
  `MirrorValue` fragments
- **Google Routes API** (travel), **OpenRouter** (address cleanup)
- **Doppler** for secrets

---

## Getting started

```bash
pnpm install
```

Secrets come from Doppler; for local work put them in `.env.local`. The full list
with notes is in [`docs/m2b/README.md`](docs/m2b/README.md) §5 — at minimum you need
`MONDAY_API_TOKEN`, plus `GOOGLE_MAPS_API_KEY` and `OPENROUTER_API_KEY` for real
travel and address resolution (both fall back to stubs without them).

No database, no Docker, no migrations.

### Commands

| Command | What |
|---|---|
| `pnpm recommend:once <mondayItemId>` | Run one training end-to-end against live Monday. Read-only. |
| `pnpm groups:list` | Trainer-group readiness; non-zero exit on an unusable selection. |
| `pnpm recommend:parity` | Compare recommended trainer sets against the legacy Airtable snapshot. |
| `pnpm replay:verify` | Deterministic replay of `fixtures/replay/` — the regression gate. |
| `pnpm test:unit` | Unit tests. |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | The rest of the gate. |

Full gate:

```bash
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm replay:verify && pnpm build
```

---

## Project structure

```
app/api/config/trainer-groups/   Internal ops endpoint (bearer-guarded)
lib/
  calc/          Pure formulas — billable hours, travel cost, rates, ranking
  monday/        GraphQL client, board config, decoders, schema checks
  recommend/     The engine: roster, qualifications, eligibility, pricing,
                 travel, artifact, service orchestration
  config/        Key/value config → validated AppConfig
  logger/        Structured logging
scripts/         Ops + verification harnesses
fixtures/replay/ Sanitized replay fixtures (committed; synthetic addresses)
snapshots/       Raw client data — GITIGNORED, contains PII, never commit
docs/build/      The current spec (from Kevin, 3 Aug) — gitignored
docs/m2b/        Operational runbook
```

## Data handling

`snapshots/` holds real client data — trainer names, addresses, client locations —
and is gitignored. Committed fixtures are sanitized copies with synthetic, stable
addresses (`scripts/sanitize-replay.ts`). Address fingerprints in the audit artifact
are keyed HMACs; no raw address is ever stored.
