# Runbook: deploying a schema change with no failure window

Any deploy that changes `api/src/db/schema.ts` follows this. The reason it exists as a runbook
rather than a habit: the ordering is not obvious, two of its steps look redundant, and this
platform has already shipped an outage by skipping one of them.

## What makes this hard

Private networking means **only the container app reaches Postgres**. A migration can therefore
only run from inside a revision built from the same commit that carries `drizzle/`. So the
migration cannot precede the image, and the image must not serve traffic before the migration.
Those two facts are what the order below resolves.

## The trap: Multiple-revision mode does not give a new revision zero traffic

Switching to `--mode multiple` and then updating the image is the obvious move and it is wrong.
The ingress traffic block reads `latestRevision: true, weight: 100`, so `containerapp update`
puts the **un-migrated** image in front of every request the moment it goes healthy. On
2026-08-16 that was about a minute of 500s on every lesson route before traffic was pinned back.

Traffic must be pinned to the OLD revision *explicitly* — that is what replaces the
`latestRevision: true` rule.

## The order

Substitute `ca-app-api-dev` / `rg-karaorchee-app-dev` for the environment you are deploying.

1. `az containerapp revision set-mode -n <app> -g <rg> --mode multiple`
2. `az containerapp ingress traffic set -n <app> -g <rg> --revision-weight <OLD>=100`
   — **before** the update, so the latest-revision rule is replaced by an explicit weight.
3. `az containerapp update -n <app> -g <rg> --image <acr>/<image>:<tag> --revision-suffix <name>`
   — the new revision comes up at 0 %.
4. Run the migration **inside the new revision**: `cd /app && node dist/db/migrate.js`.
5. `az containerapp ingress traffic set -n <app> -g <rg> --revision-weight <NEW>=100 <OLD>=0`
6. `az containerapp revision set-mode -n <app> -g <rg> --mode single`

## Reaching a shell inside a revision

`az containerapp exec` calls `tcgetattr` on **its own stdin**, so the pty has to wrap `az`, not a
script containing it. This works:

```
python3 -c 'import time,sys
time.sleep(25); sys.stdout.write("cd /app && node dist/db/migrate.js\n"); sys.stdout.flush()
time.sleep(90); sys.stdout.write("exit\n"); sys.stdout.flush(); time.sleep(5)' \
  | script -q /dev/null az containerapp exec -n <app> -g <rg> --revision <NEW> --command sh
```

The other arrangement dies with `termios.error: Inappropriate ioctl for device`.

## "migrations applied" is not evidence

Read the schema back before shifting traffic — `information_schema.columns`, `pg_constraint`,
`pg_indexes` — through a script run with `NODE_PATH=/app/node_modules`. A migration runner that
reports success has told you it ran, not that the shape you expected exists.

## Rolling the image back is a TWO-STEP once a migration is live

An older image does not know the new schema. Roll the image back **and** decide what happens to
the migration; an image built before a column existed will 500 on every route that reads it, the
same way a missed migration does. A data migration cannot be undone by an image rollback at all —
if the change rewrites or drops data, take a snapshot of what it touches before running it and
keep the snapshot until the release is confirmed.

## Dropping columns is its own deploy

A column drop runs **alone**, after the new revisions already serve 100 % of traffic — never in
the same deploy that introduces its replacement. A draining old revision executes old code
against the new schema for minutes after `containerapp update` reports the new one healthy, and
the worker is worse: a draining replica keeps its Service Bus links and goes on consuming
messages long after the revision is nominally replaced.

## Renaming a table

The worker writes some tables with hand-written SQL, so a rename is not additive the way a new
column is — an old image selecting the old name 500s instantly. Ship the rename behind a view of
the old name carrying `INSTEAD OF` triggers, give every new column a default so the view keeps
accepting old inserts, and retire the view only when the old worker's **replica count reads zero**,
not when its traffic weight does.
