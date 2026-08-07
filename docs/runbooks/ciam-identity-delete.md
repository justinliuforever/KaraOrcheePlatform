# Runbook: an account deletion whose CIAM identity is still alive

`DELETE /v1/me` destroys the platform data, then removes the person's directory
identity from the Auth tenant through Microsoft Graph. The second step is best-effort
by design — the first one has already committed, and the person is waiting. When it
does not land, the account is deleted and the sign-in identity is not, and **the app
tells the person so**: the sheet's completion state says one step is still finishing.

That sentence is a promise, and this runbook is the thing that keeps it.

## The order, and why it is that way

Platform purge first, directory delete last.

The directory delete is the only step that cannot be retried from outside the request:
it needs a token that the person is about to lose. So it must run at a moment when the
tombstone that names its object id already exists — which is what makes the retry
possible at all, from either the person's next sync or from this runbook. Reversed
(Graph first), a directory success followed by a failed platform purge would strand
data belonging to somebody who can no longer authenticate to ask for it again, and no
query would name them.

## Finding the ones that did not finish

```sql
SELECT id, deleted_at, ciam_oid_at_delete
FROM users
WHERE ciam_oid_at_delete IS NOT NULL
  AND ciam_deleted_at IS NULL
  AND deleted_at < now() - interval '24 hours'
ORDER BY deleted_at;
```

`ciam_deleted_at IS NULL` means "Graph never confirmed it". The 24-hour floor exists
because the app's own next sync retries once, so a fresh row is not yet a problem.
Rows this query returns are the manual work.

## The alert (founder/lead applies this — no agent touches Azure)

The API emits one structured line per unfinished attempt:

```
{"kind":"ciam_delete_pending","userId":"…","reqId":"…","reason":"graph_http_500"}
```

Log Analytics query, action group `ag-karaorchee-ops` (the same one `alert-sb-deadletter`
uses), evaluated every 15 minutes over a 1-hour window, fires at count > 0.

The API container runs with `--logs-dynamic-json-columns true`, so a stdout JSON line is
exploded into `Log_<field>_s` and `Log_s` can be empty. Match both shapes — the same
`column_ifexists` defence `opslogs.ts` uses — or the alert silently never fires:

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s startswith "ca-app-api"
| extend kind = tostring(column_ifexists("Log_kind_s", "")),
         raw  = tostring(column_ifexists("Log_s", ""))
| where kind == "ciam_delete_pending" or raw has "ciam_delete_pending"
| project TimeGenerated, kind, raw,
          userId = tostring(column_ifexists("Log_userId_s", "")),
          reqId  = tostring(column_ifexists("Log_reqId_s", ""))
```

Verify the alert by running the query once against a window in which a delete is known to
have failed — an alert nobody has seen return a row is not known to work.

A **different** line, `{"kind":"ciam_delete_skipped","reason":"graph_not_configured"}`,
is emitted while the Graph credential does not exist (FG-7). It is deliberately not the
same kind: before FG-7 every deletion emits it, and an alert on it would be noise that
teaches people to ignore the alert that matters. The SQL query above still finds those
rows, which is correct — they are genuinely unfinished.

A **half-set** credential trio — one or two of `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` /
`GRAPH_CLIENT_SECRET` present, the rest missing — is a deployment mistake, not a
decision, so it emits `{"kind":"ciam_delete_pending","reason":"graph_config_incomplete"}`
and reaches the alert above. Post-FG-7, a secret dropped from an ACA revision is exactly
this shape; it must not arrive wearing the label operators were told to ignore.

One more line exists and does **not** mean unfinished work:
`{"kind":"ciam_delete_stamp_failed"}`. Graph confirmed the identity is gone and only the
`ciam_deleted_at` write failed. The SQL query returns that row; any retry — the person's
own sync, or step 2 below — gets 404 from Graph, which counts as done, and stamps it.

## Release ordering: the sync guard and FG-7

**The `users/sync` tombstone guard must not be serving the 13 beta accounts before the
Graph credential exists (FG-7).** Part 0.1 rolls platform changes continuously during
Phase I while FG-7 blocks only the release train, so this window exists by construction
and someone has to hold it shut deliberately.

Why: with no credential, `ciam_deleted_at` can never become non-NULL, so the pending
state is permanent. The directory object keeps the same object id, so if that person
signs up again they present the same oid, hit `ciam_oid_at_delete`, and get 410 on every
sync from every device — indefinitely. Before 0027 they simply got a fresh row.

Migration 0027 itself is additive and inert; deploy it whenever. The **guard** is what
waits. If an image carrying the guard reaches a Graph-less environment anyway, the escape
is not code: run "Finishing one by hand" below — delete the directory object, stamp the
row — after which the person signs up again with a **new** oid and a new row, and the
tombstone stops matching them.

## Finishing one by hand

1. Take `ciam_oid_at_delete` from the query. It is the directory object id; the email is
   already gone from our side, deliberately.
2. In the Auth tenant, delete that user (admin centre, or
   `az rest --method delete --url https://graph.microsoft.com/v1.0/users/<oid>`).
   404 counts as done — the object is not there, which is the whole point.
3. Stamp it, so the row stops appearing here and the sync guard stops retrying:

   ```sql
   UPDATE users SET ciam_deleted_at = now(), updated_at = now() WHERE id = '<userId>';
   ```

4. Do **not** clear `ciam_oid_at_delete`. It is retained permanently: it is the only
   thing that recognises a still-valid token from this deleted account and refuses to
   re-create the row. Clearing it re-opens the resurrection hole in both states.

## What the person's own device does

A stale device that still holds a token will call `POST /v1/users/sync`. That call gets
**410 `account_deleted`** in both states — pending and confirmed — and never re-creates
the row. In the pending state it also makes exactly one more Graph attempt, because a
live token is the strongest evidence the directory object is still there. The app signs
out and shows "This account was deleted."

## The blast radius, stated (FG-7, founder-accepted)

The Auth tenant is ONE user pool shared with the old karaorchee.com web system. Deleting
the directory object removes that email's sign-in **everywhere**, not only in Notes. The
founder accepted this; the disclosure sentence — "This also removes this email's sign-in
at karaorchee.com." — is printed in the delete sheet and in the privacy notice before
anyone confirms. There is no pre-delete check for old-web usage: option (i) was chosen.

Microsoft soft-deletes the directory object for 30 days and then purges it. We do not
hard-purge, and we do not restore.

## Accounts deleted before this shipped (FG-21, documented acceptance)

Deletions that happened before W7 left their CIAM identities alive and stashed no object
id, so nothing here can find them and the sync guard can never fire for them. At beta
scale that cohort is plausibly empty. Accepted as-is, with a named revisit trigger: **App
Store submission**, where a founder-gated one-time manual review (Auth-tenant users ∩
active platform oids ∩ admin ∩ old-web population) either removes confirmed Notes-only
orphans or re-documents this acceptance. No sweep before then — an automated one is
dangerous for exactly the shared-pool reason above.
