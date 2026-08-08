@AGENTS.md

# CLAUDE.md — KaraOrcheePlatform

The Azure platform behind **KaraOrchee Notes**: the API, the notes worker, the pieces/engraving
worker, and the admin console. The iOS app that consumes it lives in `~/Desktop/KaraOrcheeAMT`; the
AMT engine and tracker live in `~/Desktop/KaraOrcheeCode/piano-amt`. This repo forks neither.

> This repository had no CLAUDE.md until 2026-08-08, so no project instruction loaded when a session
> started here — `KaraOrcheeCode/CLAUDE.md` is a sibling directory, not an ancestor, and is never
> picked up from this working directory.

## Where the truth is

| You need | Read |
|---|---|
| Resources, Postgres schema, API routes, CIAM, worker pipeline, deploy | `docs/platform.md` |
| Decided-but-unbuilt, built-but-unapplied, deliberately deferred | `docs/open-items.md` |
| Secret rotation, Postgres restore | `docs/runbooks/` |
| What shipped when | `docs/CHANGELOG.md` |
| Tenants, subscriptions, which resource group a resource is in | `~/Desktop/KaraOrcheeCode/notes/azure-infra.md` |

Constraints that a subsystem's code cannot state itself live in `.claude/rules/*.md`, scoped by path
so they load only when the matching files are open.

## Build, test, migrate

```bash
cd api && npm test          # vitest
cd api && npm run build     # tsc
cd api && npm run db:migrate
```

**A schema.ts change ships with a migration, and the migration is proved by querying the database —
never by the migration runner's exit code.** A run inside a container image that predates the
migration file reports success having done nothing; that happened, and the roster 500'd for days.

## Discipline

- **Commit only when asked; never add a `Co-Authored-By` trailer.** Push only when asked.
- **Planning or discussion means no code** until the founder says to implement.
- **Verify real names** — database, container, resource, collection — by reading the codebase. Never
  assume a default.
- **Azure auth is API keys / connection strings**, not credential-based auth, because tokens expire.
  The one shipped exception is `api/src/opslogs.ts`: Log Analytics accepts Entra auth only. Do not
  "fix" it.
- **Deployments are dev unless the founder says otherwise.** Any prod deployment is founder-gated.
- When several agents work at once, each takes disjoint files. Two agents never edit one file.
