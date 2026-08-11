# Open items

Everything decided-but-unbuilt, built-but-unapplied, or deliberately deferred. Updated 2026-07-26.

Nothing here is forgotten work — each line says who it waits on and what unblocks it. Delete a line when it lands, do not let it rot into "we should probably".

---

## Waiting on the founder

| Item | What is blocked | Notes |
|---|---|---|
| **Transcript 90-day retention** | The app tells users cloud audio is deleted at 90 days; a transcript is that recording in another encoding and currently never expires | The rule is written in `infra/main.bicep` (`notes-transcripts-delete`) but **not applied**, because switching it on starts expiring transcripts that exist today. Needs a yes. |
| **Prompt: forbid elided quotes** | ~15% of annotations are discarded | Measured, not guessed: the verbatim-quote gate drops an annotation when the model joins non-adjacent phrases with `...`, and that was the *only* loss mechanism observed in a real run — 2 of 13, both from that cause, one carrying the run's only unconverted bar number. One sentence in `worker/notes/prompt.py` RULES. Cost: the prompt was three-way verified and would need re-verification. |
| **App version bump** | Nothing | 0.8 recommended (Notes is a new product surface, not a point fix). Founder said: decide at archive time. Build number must also increment or TestFlight rejects the upload. |
| **Narration cool-tiering** | Nothing — cost only | `notes-narration-cool` is in bicep, not applied. Cold-tier reads cost extra, so this may cost more than it saves if students revisit old notes. Revisit with real replay data. |
| **A dev Notes account for the tooling** | The score-scan routes have no re-runnable end-to-end test against the deployed API | `tools/scan_e2e/smoke.py` is written and ready — create, duplicate create, upload, commit, commit-again, detail, the two 415s, delete. The only credential we hold is the batch-tools admin identity, which has **no `users` row** on dev, so every call 404s at `/v1/me`. Signing it up would make the founder's own identity a Notes teacher on dev permanently — `DELETE /v1/me` tombstones the CIAM identity, so it cannot be undone without losing that sign-in. Needs a throwaway account instead. |

## Engraving round 3 — where it stands (2026-08-07)

**Shipped and verified.** worker revision 0000030 = `ea47a05`. Fifteen pieces republished, none
failed. The published Hanon had been PLAYING an octave low — not just printing low — because
Dolet drops an octave line and its pitch compensation in the same routine, and the batch
reference MIDI is synthesised from that same XML. Live v4 of `hanon_virtuoso_pianist_no_39` now
matches the engraver's own MIDI note for note across the first 64 onsets; it did not before.

- octave reconstruction: 61/61 dropped lines matched, 819 + 193 notes raised, 3 noteheads moved
  of 8249. Tool at `scratchpad/wf3/octrecon/` (not in the repo — it is a one-off).
- five render fixes in `2df0806`: pedal Ped.+line (MEI `form="pedline"`), duplicate pedal starts
  dropped (209 overlaps → 0), key signature left of a merged `:||:`, symbol-overridden rests
  printed, barline graces rejoined.
- republished: Hanon 32/33/38/39/40/41/42, Clementi Op.36 No.2 ii + No.3 i, Chopin Op.34 No.1 +
  No.3, Liszt Feux Follets, K.331 i + iii, K.330 ii.

**Committed but NOT deployed.** `a652a80` reads Dolet's `<?DoletSibelius …?>` notices from the
raw upload bytes and blocks only what would make a musician play wrong notes. Verified: the
engraver's original files block, the reconstructed ones pass. Needs one more worker deploy.

**Waiting on the engraver.**
- Chopin Op.34's 11 dropped octave lines cannot be reconstructed (199 grace notes; the MIDI has
  392 more notes than the score, so the alignment will not converge). He must redraw them. The
  two-minute experiment to confirm the method: delete and redraw the 8va at No.3 bar 169 — NOT
  copy-paste — re-export, and `Unrecognized line style` should fall 16 → 15.
- A MuseScore engraving of the whole Chopin Op.34 for the platform comparison. Judge it with
  the same gate: zero Dolet notices, and `<octave-shift>` count equal to the lines he drew.

**Founder decision pending.** Honouring his line breaks (`breaks: "line"` on phone and
ipad_portrait) reproduces his bars-per-system exactly — 51 systems, vector identical. Costs a
whole-library re-render and 20-45% more scrolling. iPad landscape should stay auto: six bars
across 232 staff spaces looks empty.

**Known remaining defects.**
- 52 notes in Hanon No. 41 (bars 423-486) still disagree with the MIDI. They carry no dropped-line
  notice and sit INSIDE brackets Dolet did export — a separate, pre-existing fault. The
  reconstruction correctly refuses them.
- `rach_op23_4` and `schubert_sonata_894_mvt2` still cannot take a new render (see below).
- Hanon No. 43 passes every gate now but is a NEW catalogue entry; the engraver asked to review
  new pieces himself, so it should go to Review, not straight to publish.

## The Dolet notice "gate" does not gate (2026-08-09)

`a652a80` reads `<?DoletSibelius …?>` out of the raw upload and computes
`severity: "block"` for the notices that mean lost pitch. **Nothing reads that field.** Verified:

- `worker/pieces/gates.py` never mentions `export_warnings` or `severity`.
- Repo-wide, `"block"` appears only inside `dolet_notices.py` itself — the assignment at `:89`
  and a *sort key* at `:135`.
- `apps/admin/src/api.ts:237` types `export_warnings` as `{code, measures}` — `severity` is not
  carried to the client at all.
- `apps/admin/src/studio/wizard/FactsCard.tsx` holds an allowlist of exactly two codes,
  `sibelius_direct_export` and `fingering_stack_no_position`. Every `dolet_*` code maps to
  `undefined` and is dropped by `.filter(Boolean)`.
- Mutation check: replacing the whole body of `dolet_notices()` with `return []` still passes
  all 156 `worker/pieces` tests.

So it is an end-to-end no-op. **Do not upload the next batch believing octave-line loss is now
caught.** It is not; it would repeat the 61-dropped-line incident silently.

Wiring it up is three small edits — carry `severity` in `api.ts`, add the `dolet_*` codes to the
FactsCard allowlist, and have `gates.py` fail on `severity == "block"`. The third changes upload
behaviour (it can reject the engraver's file), so it wants its own review, not a drive-by.

Deployed on worker `bd8ed04` anyway, because it is HEAD and it is inert.

## MuseScore was measured once, on the wrong piece (2026-08-08)

The engraver sent a MuseScore Studio 4.7.4 export of Clementi Sonatina Op. 36 No. 1. We hold
his Dolet export of the same file, so this is a controlled A/B: same engraver, same edition,
134 measures, 1243 notes, 422 fingerings on both sides.

**It cannot answer the question that prompted it.** Neither export contains a single
`<octave-shift>` or `<pedal>`, and `dolet_notices()` returns `[]` — Dolet dropped nothing from
this piece. The 8va failure has no counterpart here. So does D.C./D.S., metronome marks,
`<symbol>` rest overrides, and interleaved voices: zero instances of each, in both files. Eight
`engraving_norm` passes never executed. **A verdict on MuseScore needs Chopin Op. 34.**

**Three defects the MuseScore round-trip introduced**, all invisible to every gate we ship:

- **m59** — the two grace notes that terminate the trill move from staff 1 / voice 1 at the end
  of the bar to staff 2 / voice 5 at the start of it. Wrong hand, wrong beat. The only
  note-level divergence in 1134 notes.
- **13 of 25 multi-fingering stacks are ordered wrongly** — 23 digits across the 11 real chords,
  plus two single-note substitution pairs (m7, m8). MuseScore assigns a
  multi-`<fingering>` list bottom-to-top in document order and discards `default-y`; Dolet's
  document order is arbitrary and the truth is *only* in `default-y`. Verified exactly, 25/25
  with no exception. Clearest case m87: left hand D3+A3, Dolet gives 5 to D3, MuseScore gives 5
  to A3. **Unrecoverable** — the original geometry is not in the exported file, so no change on
  our side can fix a file that has been through MuseScore.
- **m16, m20, m49** — MuseScore's `<tied type="let-ring"/>` imports as MEI `<lv>` with
  `tstamp2` 0.05 beats after the start, and verovio paints a 0.36 × 0.64 staff-space mark that
  reads as a marcato accent over the notehead. Dolet writes a stop-less `<tie>` there, which
  prints nothing. Neither is right; MuseScore's is worse because it prints a wrong instruction.
  verovio 6.2.1-8d42439.

Where MuseScore is better: it closes every slur (135/135 vs Dolet's 138/136, two unclosed at
m42-43 and one degenerate at m49), emits no importer warnings, and writes `<fz/>` as one object
where Dolet splits it into `<f/>` plus a bare `<words>z</words>` (both render identically today).

**Provenance is unconfirmed and it matters.** MuseScore cannot open `.sib`, so this is almost
certainly a MusicXML round-trip of the Dolet export, not a native engraving. If so, every defect
above belongs to the *migration path*, and a natively-engraved MuseScore file could differ in
both directions. **Ask before generalising.**

If we ever accept MuseScore files, the must-fix list is: refuse to guess a fingering pairing when
the `default-y` steps are a near-constant monotone ladder and there are ≤2 distinct `default-x`
in the file (`engraving_norm.py:219` → `fingering_layout.py:77`); un-gate the fingering warnings
from `"Dolet" in software` (`xml_meta.py:161`, and `tests/test_xml_meta.py` asserts the current
behaviour); rewrite or strip `<lv>@tstamp2`; make the substitution guard at
`engraving_norm.py:134` use horizontal rather than vertical separation; and teach
`structure.py` `_reject_jumps` to consume `<sound dacapo>` instead of rejecting it — MuseScore
writes D.C. that way, which is the opposite of Dolet's words-only form and is certain to appear.

Screenshots: `~/Desktop/MuseScore_vs_Sibelius_对比/`.

## Two catalogue rows contradict their own page (2026-08-08)

`clementi_sonatina_c_major_op_36_no_1_i_allegro` ships subtitle *I. Allegro* while its own facts
card says *Spiritoso.* — which is what is printed. Same shape in
`clementi_op36_5_2`: subtitle *II. Allegretto moderato — Swiss Air*, page *Allegro moderato*. The
two fields have different sources and never compete: the subtitle comes from `library_plan.py`
(and the engraver's `A-Info.docx`), `facts.tempo_text` from the score's own `directive="yes"`
words. The whole facts object ships to the app, so both strings are user-visible. Possibly
deliberate edition naming — **ask the engraver before "fixing" it.**

Not a defect, recorded so it is not re-investigated: `TERM_BPM`'s `"default"` tag marks a bpm
taken from Sibelius's own playback dictionary for that term, not a fallback for an unknown word.
`spiritoso`, `allegro vivace` and `allegro moderato` are all in the table.

Unresolved: the engraver's sibling MIDIs carry their own tempo maps (Clementi No. 1:
100 / 80 / 120 against our 120 / 75 / 140). **Do not adopt these without checking.** All fifteen
Bach inventions share a single 100 and all of Hanon Part II a single 60 — Sibelius's no-mark
default. `TEMPO_OVERRIDE["clementi_op36_5_1"] = 160` was safe precisely because 160 is *not* a
default.

## The Dropbox library moves under us

Four published pieces (Hanon Part II Nos. 39-42) sat for two weeks on a July 19 upload of
an unfinished export while the engraver's finished file waited in Dropbox from July 22 —
2165 fingerings, 40 ottava spans and 36 key captions missing, 510 notes an octave from
where he put them. Nothing flagged it: the source we hold is whatever we uploaded, and
nothing compares it to what he has now.

**Before trusting any published piece, diff its source against the current Dropbox file.**
Re-checked 2026-08-03: Hanon 39-43 was the only stale set. K.330's collection was also
renamed (`Kv.330` -> `K.330`), which broke the splitter outright — collection paths are
not stable either.

Outstanding from that check:
- **Hanon No. 43** — nested repeats (forward marks at measures 2 and 5). Blocked on the
  engraver rewriting the section, or on the expander learning nested repeats.
- **Mozart K.333** — 476 bars, three movements (m1 / m168 / m251), uploaded 2026-08-03,
  never processed. Needs a work row and book index before it can be split.
- **Mozart K.331 mvt 2** — the engraver added `Fine` and `Menuetto D.C. al Fine`, but in
  the Tempo text style, so Sibelius's own engine still does not execute the D.C.
  (`BarPlaybackOrderString` unchanged). Needs the Repeat style, then Phase-D.
- **Hanon No. 39 ottavas** — present only from bar 223 (B major) onward; the printed
  edition brackets the earlier keys too. Pitches are the engraver's, so this is an
  engraving-consistency question for him, not a correctness one.

## Two pieces cannot take a new render

`rach_op23_4` and `schubert_sonata_894_mvt2` fail the staff-timeline gate at 0.954 and
0.975 against a 0.98 floor, so they kept their old bundle in the 2026-08-02 republish
(117 of 119 went through). **This is not a regression** — measured identical under the
previously deployed pipeline. Their reference MIDI realises ornaments as individual
notes (Schubert: groups of three ~75ms apart; Rachmaninoff: pairs ~160ms apart) while
the page draws one symbol with one anchor, so those onsets have nothing to pair with.
Every anchored onset is exact (p50 = p90 = 0ms). Fixing it means either an ornament-aware
anchor or a MIDI without realised ornaments; neither is urgent — both pieces are live and
correct, they simply do not carry the new fingering and layout work.

## Hard gates before the first external TestFlight build

| Item | Why it blocks |
|---|---|
| **Dual-role routing** | An account holding both capabilities resolves to the teacher home forever. Documented deferral; must not ship to strangers. |
| **Custom domain** | `PlatformConfig.swift` hardcodes the Azure container-app hostname. Fine for us, wrong for an external build. |
| **Geo-redundant Postgres backup** | Creation-time only — it cannot be enabled on an existing server. Must be set when the prod database is created. |

## Deliberately not doing yet

| Item | Why not, and what would change it |
|---|---|
| **Push notifications, and the APNs key with them** | Nothing | **Founder decision: beta ships without push.** The whole path is built and inert — the API runs with `apns: null`, notes send exactly as today, nothing crashes and no send is blocked. Setup steps live in `docs/runbooks/secret-rotation.md` for the day it changes. **Two things must land in the same session as the key, not after it:** `unregisterDevice` had no caller anywhere and was deleted as dead code on 2026-08-11, so neither sign-out nor account deletion stops pushes — the client call has to be re-added at both sites; and `APNS_ENVIRONMENT` defaults to `production` when unset, so a dev rollout that forgets `sandbox` fails every push silently. |
| **StoreKit / paywall** | Two notes and five users. Prices are decided; building against no usage is not. Revisit when there is a cohort to charge. |
| **The teacher's real voice per annotation** | The worker half is a cheap deterministic derivation from timings we already store — which is the trap. There is no read path for lesson audio, no behaviour designed for when the audio ages out, and a consent question that is not an engineering call: a student consented to being *recorded*, not to the recording being replayed on demand. If it ever starts, start with self-recorded notes, where the voice belongs to the listener. |
| **Placing as a third score-tab mode** | Strictly better than the modal sheet, and premature until we know placing is the bottleneck. |
| **A labelled-step LLM pass** | Would give steps names instead of numbers. Conditional on the founder disliking numbered steps in real use. |
| **Another adversarial review of the note player** | It shipped with one. The last two field tests each produced defects no review had found. Founder time beats another review pass. |

## Known and accepted

- **A draft rebuild resets `piece_suggestion_dismissed`.** The teacher INSERT in `worker/notes/replace_draft` (`main.py:465-472`) is an explicit column list and that column is not in it, so a duplicate Service Bus delivery re-offers a suggestion the teacher already dismissed — which the column's own comment in `schema.ts` promises will never happen. Latent today because the piece-mention prompt ships off; it becomes visible the day that flag clears its eval. Found while carrying `score_scan_id` through the same rebuild, deliberately not fixed in that change.

- **§7 L5, "Shown in 2 notes.", is not implemented anywhere.** The viewer never tells an owner which notes are using a scan; `usedBy` is read only at the delete preflight, one sentence before the pages are destroyed. Deliberately left for Slice 3 rather than built blind — until the attach route writes `notes.score_scan_id` the array is always empty, so the line would render nothing and could not be reviewed. It should land with that route, not after it.

- **A scan with no server row is deleted without the usage preflight — a deliberate, scoped exception to §7's "no path reaches delete without a successful `usedBy`".** For every other scan the fail-closed rule stands: a lookup that fails yields D8 and delete is withheld. For a scan the server has never heard of, `usedBy` cannot merely fail — it can never succeed, because the id 404s forever, which turns D8 from a safety net into a permanent dead end with the user's own photographs stranded on their device. The predicate is `record.serverScanId == nil`, re-asked against a fresh disk read at the moment of the deed, and **it must never be keyed off `ready`**: a scan that committed while the device was offline also renders `ready: false`, and deleting that one locally would orphan its durable blobs with no handle left to reach them. Pinned by a test that fails if someone re-keys it. Note the honest limit — `serverScanId == nil` does not *prove* there is no server row, because a create whose response was lost leaves one; that row is harmless (it can never reach `ready`, never appears in a sent note, holds no durable prefix, and its staged blobs fall to the `incoming/` lifecycle rule) and it self-heals — but by the idempotent create (`scans.ts:84-97`), which hands the same row back on the retry, **not** by the preflight. An earlier version of this line claimed the preflight removes it; that is false and was proved so independently by three reviewers. `GET /v1/score-scans/:id` answers 409 on a `created` row and removes nothing. Since Slice 2's remediation the client treats that 409 as an answer and offers D1, so such a row is deletable — but never restate the general claim: a doc that says a dead end is handled is worse than one that says nothing.

- **Every `usedBy` row must carry `noteId`, `status`, `origin` and `createdAt`, or no scan can ever be deleted.** The delete confirmation is fail-closed by design: it may only run when it can name what it destroys, so the client treats a 200 whose `usedBy` element is missing any of those four as a failed lookup and withholds delete entirely. Dropping a field from the select in `routes/scans.ts` would not fail a server test — it would make delete permanently unavailable in the app. Latent until Slice 3 writes `notes.score_scan_id`; today the array is always empty.

- **`POST /v1/notes/:id/duplicate` will silently drop a score when Slice 3 lands.** The insert at `routes/notes.ts:674-683` is an explicit field list that already drops `customPieceId`. §9.3 of the scan design requires the duplicate to copy `score_scan_id` and to never copy `score_scan_detached_at` — a missed copy loses the score on every retract-and-resend, a carried marker renders "isn't available any more" on a note that never had one. Untestable in Slice 1 because no route writes `notes.score_scan_id` yet; both directions need a test the day the attach route exists.
- **iOS reclaiming `Caches/` is indistinguishable from never-generated narration.** Our own reaper leaves a marker so it reports `evicted`; the OS leaves nothing. Accepted.
- **`StudentNotesModel.warmNarration`** keeps a per-session "already asked" set that does not consult the reaped marker, so a note evicted mid-session is not re-warmed on arrival until relaunch. The player's own prefetch is the second chance. Not a live defect.
- **`pytest notes/tests pieces` in one invocation fails at collection** — the notes conftest stubs azure modules globally and poisons pieces' imports. Pre-existing. Run the two suites separately.
- **Our narration character count is not the vendor's bill.** ElevenLabs meters credits at a rate that moved from 0.50 to 0.55 per character between July runs and that none of its own endpoints report. We now record the vendor's own number per clip alongside ours; ours remains the pre-flight ceiling because it is the only figure knowable before a request.

### From the score-scan Slice 2 gate 3 (2026-08-11) — real, deliberately not fixed

- **§7 L4 needs splitting, and this is the third gate to say so.** A `created` server row this device has never held prints *"Saved on this device"* on the card and *"Not on this device"* in the viewer — one tap apart, and reachable by a reinstall or a second device. The card string is prescribed verbatim by L4 for *every* not-ready card, so the fix is a **design-table change, not a code change**: L4a for a row whose pages are on this device, L4b for one this install has never held. The signal already exists and the viewer already consults it (`ScanItem.recordId == nil`); one line in `ScanCard.secondLine` implements it the moment the table says so. **Deadline: before Slice 3**, because the attach route makes the wrong sentence visible to a student's teacher. Killed at gate 1, re-recorded at gate 2, re-derived from scratch at gate 3 — because it lived only in gate reports and never here.

- **A scan's page-1 cover survives sign-out and account deletion.** `CoverImage`'s disk cache holds `scan-<id>` — a read SAS on the page-1 blob itself, so the cover *is* a full-resolution page — and `purgeLocalContent` never touches `CoverImage`. Sign-out evicts only the covers the shelf happened to be holding, which collapses to the local rows on any failed refresh. Residue, not exposure: the keys are the departing account's server ids and only that account's item list ever asks for them. Adjudicated at gate 1 and again at gate 2; recorded here so it stops being re-derived.

- **`answeredGone` treats a 409 `scan_not_ready` as an answer and then prints D1's "No note is showing them" without asking.** §A2b explicitly permits a note to reference a scan still in `created`. Unreachable today because `usedBy` is always empty, and it goes live with the Slice 3 attach route — beside the D6b item above. The 409→D1 path itself is correct and is Slice 2's remediation; what is unrecorded is that the *sentence* asserts a fact nobody checked.

- **The review sheet's caption survives its last page.** *"Page 1 is what opens first. Use the arrows to change the order."* renders above zero rows the moment someone deletes their final page — measured on all nine `scan-empty_*` frames. Pre-existing and cosmetic.

- **`DELETE /v1/me` purges scan blobs only `if (deps.scans)`, while `DELETE /v1/score-scans/:id` refuses with 503 first.** A real asymmetry, gated on a misconfigured deployment in which every other scan route already fails loudly. Below the bar as a defect; recorded so it is not re-derived a fourth time.

### From the score-scan Slice 2 stage gate (2026-08-10) — real, deliberately not fixed

- **D6b is written for a state that cannot occur, and the state that actually reaches it is a different fact.** `DELETE /v1/me` unconditionally hard-deletes every note where `student_id = me` (`users.ts:245-249`), which §10.3(f) states — so a tombstoned recipient can never appear in `usedBy`, contradicting §7's D6b row in the same document. Meanwhile a **live** student who tapped Skip on "Your name (optional)" has `display_name` NULL forever, and the delete confirmation maps any null name to *"a student who deleted their account"* — telling a teacher a student left when they are still there. Unreachable today (`usedBy` is always empty), live the day a client attach route ships. D6b should key off a `deleted` boolean; the platform already carries one (`links.ts:304`). **Reconcile §7 and §10.3(f) before Slice 3.**

- **The page encoder strips the only orientation carrier iOS writes.** Measured: a `.right` image encodes as `orientation=6` with the pixels *not* rotated, and the allow-list then removes APP1 entirely, so it re-reads as an un-rotated `.up` image. Keeping APP1 is not an option — the commit gate refuses it. Whether VisionKit ever hands back a non-`.up` page is unreachable off-device, so this joins the device-pass list with its recipe: log `imageOrientation` before encoding, then `exiftool -Orientation` the downloaded blob. If it does happen, the page is visibly 90° wrong for the owner *and* the recipient, and retaking cannot fix it.

- **`BackgroundUploadLedger` is write-only, and its key cannot name a page.** `hasLanded` has zero callers — already true for lessons before this slice — and one key covers all N pages of a scan. Today that costs one redundant idempotent PUT after a process kill, which the system already pays on every SAS expiry. **If anyone wires it, the key must be extended first**, or a resumed scan will be judged landed on the strength of one page.

- **`taken_down` has no writer.** Nothing in `api/`, `worker/` or `drizzle/` sets it; §13 is unbuilt. The client half is built and renders correctly, so the state exists but cannot arise except by hand-run SQL. Recorded so no future review files a takedown sequence as user-reachable.

- **"Removed from your device when the upload completes" is a founder copy decision, not drift.** §6.1 mandates the row verbatim and §10.2 designs the page cache under `Caches/` four hundred lines later in full knowledge of it: the clause is about the owner's own originals, which *are* deleted on commit. The honest residue is that the row as printed reads as an unqualified device claim, and a regulator-facing reader would take it that way. One clause would close it — design owner's call, not a Slice 2 defect.

### From the score-scan Slice 1 stage gate (2026-08-09) — real, deliberately not fixed

- **The commit's EXIF gate reads the head of the file only.** `api/src/notes/jpeg.ts` stops at SOS, so "carries no APP1/EXIF segment" means "no APP1 *before* SOS"; metadata appended after the scan data survives. Nobody is harmed by it — the only actor who can place trailing bytes in the file is the scan's owner, in their own photograph — so the fix is to narrow §9.3's sentence to what the gate actually checks, not to scan 40 MiB per page. It was raised, verified, and downgraded on that reasoning; do not re-file it as a privacy hole.

- **A deleted scan leaves a 7-day recoverable tail, and that is the design.** The container has `isVersioningEnabled` plus 7-day soft delete, so `deletePrefix` removes the current blobs and leaves versions behind. §11 rule 2 states it and the shipped privacy line already promises exactly this — "recoverable by our operators for up to 7 days". The E2E leg that "found" it was listing without `--include v`; re-run it that way before anyone calls it a leak.

- **The page encoder is only correct for the source it currently has.** `ScoreScanPageEncoder`'s allow-list strips APP14/Adobe — a CMYK page then renders with inverted colour — and a multi-chunk ICC profile over 64 KiB earns a permanent 415. Both are unreachable while VisionKit is the only producer, because it hands back re-rendered sRGB. **Gate any "choose from Photos" or PDF-import entry point on fixing them**; that entry point is the day both become live.

- **`ScoreScanStore` and `LessonSessionStore` share 62 identical lines on purpose.** Swift forbids static stored properties in generic types, which is where the shared `ioLock` would have to live, and the slice budgeted exactly one refactor of shipped lesson code — `LessonUploader` — so spending it here would have been the wrong one. **Pre-declared extraction trigger:** extract a `FileLedger` when a third ledger appears, or when the `update`/`rawSave` bodies diverge for any reason other than the record type.

- **20 pages CAN exceed `MAX_SCAN_BYTES`, and the copy for that case still does not exist.** The cap is 40 MB checked against the *sum* of the pages and the encoder does no downscaling. Measured 2026-08-11 by running `ScoreScanPageEncoder` over nine real photographs of printed scores (`KaraOrcheeAMT/Tests/ScanRealPageMeasurementTests.swift`, sim 967CA7A5, app at 22ada9d; numbers in `KaraOrcheeNotes_v10_Scan_Design/evidence_real_scores/measurements.json`):

  | page pixels | bytes per page at q0.8 | × 20 |
  | --- | --- | --- |
  | 1.6–2.1 MP (the photographs as supplied) | 230–422 KB | **4.5–8.4 MB** |
  | 6.2–8.3 MP | 646–1215 KB | 12.6–23.7 MB |
  | 14.0–18.7 MP | 1199–2197 KB | **23.4–42.9 MB** |

  Read the bottom row as a **lower bound, not an estimate**: every row below the first is the same photographs resampled up, so they carry none of the detail a real capture would add, and JPEG pays for detail. The inkiest page is the one that reaches 42.9 MB. So at VisionKit-class resolution "That's 20 pages — the most one score can hold" is a promise the server can refuse, and at a 12 MP capture the margin is already under 20%. **Still open, and what would close it:** the pixel size VisionKit actually returns on the target devices, which is unreachable off-device. Two sentences are missing whatever that number turns out to be — §7 state 6's repair clause ("Delete a page to add another"), and any sentence at all for pages dropped over the cap or for a full disk. The mitigation nobody has costed is downscaling in the encoder, which is the same lever as the fidelity item below.

- **The nine sample photographs cannot test the EXIF gate, the orientation carrier, or the 64 KiB head — and no sample that arrives by message ever will.** All nine carry APP0/JFIF only, or APP0 + APP2/ICC; none carries APP1, because the transfer that delivered them downscaled to 1080-wide and stripped metadata. All nine decode `imageOrientation == .up`, so they say nothing about the orientation item above either. What they do test is real printed-score content through both halves of the wire, and they are in the conformance corpus as its `photo_*` and `encoded_*` cases. They are also **not** a test of the shipped capture path: they carry background clutter, a finger, glare and page curvature that VisionKit's document detection would crop and de-warp away.

- **`compressionQuality: 0.8` is not shown to be wrong, and the evidence that would settle it does not exist yet.** The question is whether q0.8 destroys the pencil annotation a teacher photographs the page *for*. Measured on a page carrying pencil analysis marks: against the photograph as supplied, q0.8 moves the annotated crops by **MAE 0.40–0.45** of 255, maximum deviation 3 levels, ink depth unchanged. That number is not the answer, because these photographs arrive **already quantised more coarsely than q0.8 applies** — source luma quantisation table mean 27.70 against q0.8's 7.42, and even q0.6's 16.08 — which is also why the encoder's output is *larger* than its input, 422 KB from 284 KB. On content where the quantiser does bind (the same page resampled to half size, against its own q1.00) q0.8 costs **MAE 1.67–1.79 on the pencil crops and 1.74–1.79 on the printed crops**: it treats handwriting and engraving alike, ink depth moving under 2% either way. Grey pencil is carried by luma and the encoder is 4:2:0, so chroma subsampling never reaches it. **Recommendation: leave 0.8 alone.** What would overturn it is a VisionKit capture of an annotated page at sensor resolution — the same device pass the orientation item waits on. Decide it together with the byte item above, which pushes the other way.

## Verified clean, so nobody re-opens them

- **The model does not invent bar numbers.** A lesson with zero spoken bar numbers but 24 spoken numerals (a teacher counting beats) produced 5 annotations and 0 placements; one annotation quoting "One, two, three. On each beat you have one note." was classified as a deixis reference, not a bar.
- **Authenticated responses carry `no-store` and `Vary: Authorization`**, set in `requireAuth` so every future authenticated route inherits them. Verified against the deployed revision, not only in tests.
