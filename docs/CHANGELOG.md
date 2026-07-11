# Admin Console Changelog

The version shown in the sidebar (`vX.Y.Z · <sha>`) has two parts:
- **X.Y.Z** — semantic version from `apps/admin/package.json`. Bumped ONLY with
  explicit founder sign-off, one entry per bump below. Never bump casually.
- **sha** — the git commit the running build was made from (injected by
  `scripts/deploy.sh`); changes on every deploy, needs no ceremony.

## 0.8.0 — 2026-07-11 (founder-verified; colleague handoff release)

Founder ran the full 12-point walkthrough and signed off. Everything below shipped
since 0.7.0, verified on dev:

- **Collections page** (new sidebar tab): books and works become first-class
  managed entities. Books: cover grid, detail panel with cover replace, field
  edits (title/author/publisher/edition/rights), whole-book table of contents,
  bulk renumbering (swap-safe), New book dialog, delete for empty books, coverless
  books flagged loudly. Works: searchable table, field edits, movement list,
  volume nesting display, duplicate-work merge tool (movement numbers kept,
  same-instrument clash re-confirm), delete for empty works.
- **Ops tab** (new sidebar tab): the site's logs become queryable in the console.
  Logs view (facet rail with counts, click-any-value-to-filter, severity-stacked
  brush-zoom histogram, dense table, detail drawer with per-field filter/copy),
  Errors preset view, Queue view (Service Bus counters, dead-letter peek with
  screaming red, recent worker jobs). Flagship: request timeline — one click on a
  reqId merges API request logs, queue-worker logs, and business audit events into
  a single chronological lane view. Form-first design (no query language), all
  state URL-shareable, saved views. Backed by an Entra managed-identity proxy
  with allowlisted KQL composition (browser never sees KQL or credentials).
- **Audit shows WHO everywhere**: every history/activity list carries the actor's
  email (user, piece, book, work panels); version history shows who published;
  the studio board gains a "By" column and job pages name their creator. Audit
  events now stamp the request id, and each entry links straight to its Ops
  request timeline ("trace").
- **Presentation 2.1 + tag system**: Inter with tabular numerals, global Cmd+K
  command palette, denser tables, unified status-tag registry (lifecycle dot
  pills / rights outline with blocked-red / shelf subtle; every tag explains
  itself on hover, click-to-filter in tables), five-bar difficulty meter, empty
  states, focus rings, clickable version chip.
- **Admin 2.0 foundation**: full shadcn (ui-kit) migration — wizard decomposed
  (1268→490 lines, cache behavior re-verified), Sheet-based slide-overs,
  AlertDialog confirms, toasts.
- Studio wizard: reference-audio verification card (Tier-1/Tier-2 with alignment
  quality), uploaded-recording player beside the synth preview, listen-before-
  publish card on job pages; false "Pieces page cover upload" hint fixed to point
  at Collections.

## 0.7.0 — 2026-07-11 (baseline)

First versioned release. State at baseline:
- Pieces Studio: files-first wizard (instrument → MusicXML+MIDI+optional audio),
  preflight gates streamed live, XML facts card, solo-part selection, preview audio,
  works/books membership lanes, rights gate, full re-verification on submit,
  failure auto-diagnosis (tempo/structure/content attribution), human review, publish.
- Reference audio: Tier-1 (notated tempo) and Tier-2 (expressive performances —
  MrMsDTW-aligned, self-verified incl. pitch-content identity), unified time-map
  artifact for the app.
- Pieces Library: search/filters incl. works, large slide-over manager, two edit
  lanes (metadata in place / content via new version), work membership editing,
  archive/takedown/restore, full version+sources+build+audit visibility.
- Users: roles management with audit.
- Platform: 8-agent adversarially-reviewed hardening, site-wide structured request
  logging, dead-letter alerting, worker test harness, shadcn (ui-kit) foundation.
