# Admin Console Changelog

The version shown in the sidebar (`vX.Y.Z · <sha>`) has two parts:
- **X.Y.Z** — semantic version from `apps/admin/package.json`. Bumped ONLY with
  explicit founder sign-off, one entry per bump below. Never bump casually.
- **sha** — the git commit the running build was made from (injected by
  `scripts/deploy.sh`); changes on every deploy, needs no ceremony.

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
