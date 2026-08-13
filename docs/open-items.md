# Open items

Everything decided-but-unbuilt, built-but-unapplied, or deliberately deferred. Updated 2026-08-13.

Nothing here is forgotten work — each line says who it waits on and what unblocks it. Delete a line when it lands, do not let it rot into "we should probably".

---

## Reaching Postgres from here — the recipe, since it is needed again

This machine cannot reach `pg-karaorchee-app-dev` directly (private networking; only the container app gets through), and the previous note called `az containerapp exec` fragile because it "worked once and timed out". It was not fragile — it was three separate mistakes, each with a fix:

1. **stdin is consumed before the container connects.** Piping the command in at once feeds it to the az CLI's own startup, and the shell comes up empty. Delay the write **~30 s** (`python3 -c "import time,sys; time.sleep(30); sys.stdout.write(…)"`), and send `exit` as its own later write. Twelve seconds was enough once and not enough the next time.
2. **`--command` splits on spaces**, so pass the single token `sh` and send the real command over stdin.
3. **A script written to `/tmp` resolves modules from `/tmp`.** Base64 it in, then run it with `NODE_PATH=/app/node_modules`, or `cd /app` first for anything using a CWD-relative path — `migrate.ts` reads `./drizzle`.

The runtime image carries `drizzle/` and `dist/`, so **`cd /app && node dist/db/migrate.js` is `npm run db:migrate`** run from inside the cluster. Wrap the whole thing in `script -q /dev/null` for a TTY, and give `timeout` at least 260 s. One command per session — two long lines in one session interleave in the pty and neither runs.

**Both former operator actions are done (2026-08-13).** The count ran first, on revision `0000060`, before the repair could erase the evidence: **0 violating rows of 8 notes**. `ck_note_piece_excludes_scan` then landed as migration `0029` on revision `0000061`, verified by reading `pg_constraint` back. The invariant is no longer a promise made by seven statements.

## Waiting on the founder

| Item | What is blocked | Notes |
|---|---|---|
| **Transcript 90-day retention** | The app tells users cloud audio is deleted at 90 days; a transcript is that recording in another encoding and currently never expires | The rule is written in `infra/main.bicep` (`notes-transcripts-delete`) but **not applied**, because switching it on starts expiring transcripts that exist today. Needs a yes. |
| **Prompt: forbid elided quotes** | ~15% of annotations are discarded | Measured, not guessed: the verbatim-quote gate drops an annotation when the model joins non-adjacent phrases with `...`, and that was the *only* loss mechanism observed in a real run — 2 of 13, both from that cause, one carrying the run's only unconverted bar number. One sentence in `worker/notes/prompt.py` RULES. Cost: the prompt was three-way verified and would need re-verification. |
| **App version bump** | Nothing | 0.8 recommended (Notes is a new product surface, not a point fix). Founder said: decide at archive time. Build number must also increment or TestFlight rejects the upload. |
| **Narration cool-tiering** | Nothing — cost only | `notes-narration-cool` is in bicep, not applied. Cold-tier reads cost extra, so this may cost more than it saves if students revisit old notes. Revisit with real replay data. |

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

- **§7 L5, "Shown in 2 notes.", shipped in Slice 3 — this line used to say it was unbuilt, and was stale by this file's own rule.** It is rendered at `ScanViewer.swift:459-461` (drawn `:66-73`, fed `:220`), and its stated trigger — the attach route writing `notes.score_scan_id`, so `usedBy` is no longer always empty — has fired. Kept as one line rather than deleted because the sentence is now load-bearing in an unobvious direction: it is what made the S3 attach defect *visible to the owner*, printing "Shown in 1 note." beside a scan whose note drew no Score section at all.

- **A scan with no server row is deleted without the usage preflight — a deliberate, scoped exception to §7's "no path reaches delete without a successful `usedBy`".** For every other scan the fail-closed rule stands: a lookup that fails yields D8 and delete is withheld. For a scan the server has never heard of, `usedBy` cannot merely fail — it can never succeed, because the id 404s forever, which turns D8 from a safety net into a permanent dead end with the user's own photographs stranded on their device. The predicate is `record.serverScanId == nil`, re-asked against a fresh disk read at the moment of the deed, and **it must never be keyed off `ready`**: a scan that committed while the device was offline also renders `ready: false`, and deleting that one locally would orphan its durable blobs with no handle left to reach them. Pinned by a test that fails if someone re-keys it. Note the honest limit — `serverScanId == nil` does not *prove* there is no server row, because a create whose response was lost leaves one; that row is harmless (it can never reach `ready`, never appears in a sent note, holds no durable prefix, and its staged blobs fall to the `incoming/` lifecycle rule) and it self-heals — but by the idempotent create (`scans.ts:84-97`), which hands the same row back on the retry, **not** by the preflight. An earlier version of this line claimed the preflight removes it; that is false and was proved so independently by three reviewers. `GET /v1/score-scans/:id` answers 409 on a `created` row and removes nothing. Since Slice 2's remediation the client treats that 409 as an answer and offers a delete, so such a row is deletable — under §7 **D1b**, whose sentence claims no usage, not D1's — but never restate the general claim: a doc that says a dead end is handled is worse than one that says nothing.

- **Every `usedBy` row must carry `noteId`, `status`, `origin`, `recipientDeleted` and `createdAt`, or no scan can ever be deleted.** The delete confirmation is fail-closed by design: it may only run when it can name what it destroys, so the client treats a 200 whose `usedBy` element is missing any of those five as a failed lookup and withholds delete entirely. Dropping a field from the select in `routes/scans.ts` would not fail a server test — it would make delete permanently unavailable in the app. **`recipientDeleted` joined the list on 2026-08-11 and is the one field the deployed API did not always send, so the API must deploy before the app build that requires it** — the general skew rule in `AGENTS.md` ("missing fields stay absent, never fatal") is deliberately inverted for this one type, and has been since Slice 1. The failure is safe in direction (delete withheld, never a wrong sentence) and total in effect.

- **A scan that was still `created` when its reader opened the note is stamped anyway, if it commits before it is deleted.** The wider defect — *every* `created` scan's delete stamping the marker — is closed: the predicate is on `notes/scan_delete.ts:34`. What survives is narrower and outside that predicate's reach, because the predicate reads the scan's status **at delete time**, while `read_at IS NOT NULL` (`:35`) stands in for *"was shown the pages"* — and **nothing records the latter**: `score_scans` has no `ready_at`, and `updated_at` also moves on rename. So: attach a `created` scan and send it (A2b permits it, and the send route never consults the scan); the student reads it and is correctly shown nothing (R8); the scan commits; the scan is deleted; the note is stamped, and that recipient gets R6 about a score they were never shown. The suite cannot see it either — `seedScan` (`api/test/scanDeletion.test.ts:111`) fixes each scan's status at seed time and no test transitions one between the read and the delete. **Nobody meets it today**, because `scoreGone` is decoded nowhere but `NoteScoreFields`. It must be settled in the same pass that first renders R6: every stamp written before then is unrepairable, since the fact that separates the two cases is not in the row and cannot be reconstructed from it afterwards.

- **`scan_purged` keeps D1's "No note is showing them." on a weaker footing than the other two.** For 404 the FK's `ON DELETE SET NULL` fired and for `taken_down` §10.3(j) nulls the references, so zero usage is a fact in both. A `ready` row with a null `blob_path` has no path that nulls anything — the claim rests entirely on the state having **no writer today** (same root as the `taken_down` item below). Left at D1 deliberately: D1b's "never finished uploading" would be *false* for a scan that was once ready. **If `scan_purged` ever gains a writer it needs its own sentence**, and that is the day to re-open it.

- **iOS reclaiming `Caches/` is indistinguishable from never-generated narration.** Our own reaper leaves a marker so it reports `evicted`; the OS leaves nothing. Accepted.
- **`StudentNotesModel.warmNarration`** keeps a per-session "already asked" set that does not consult the reaped marker, so a note evicted mid-session is not re-warmed on arrival until relaunch. The player's own prefetch is the second chance. Not a live defect.
- **`pytest notes/tests pieces` in one invocation fails at collection** — the notes conftest stubs azure modules globally and poisons pieces' imports. Pre-existing. Run the two suites separately.
- **Our narration character count is not the vendor's bill.** ElevenLabs meters credits at a rate that moved from 0.50 to 0.55 per character between July runs and that none of its own endpoints report. We now record the vendor's own number per clip alongside ours; ours remains the pre-flight ceiling because it is the only figure knowable before a request.

### From the score-scan Slice 2 gate 3 (2026-08-11) — real, deliberately not fixed

- **A scan's page-1 cover survives sign-out and account deletion.** `CoverImage`'s disk cache holds `scan-<id>` — a read SAS on the page-1 blob itself, so the cover *is* a full-resolution page — and `purgeLocalContent` never touches `CoverImage`. Sign-out evicts only the covers the shelf happened to be holding, which collapses to the local rows on any failed refresh. Residue, not exposure: the keys are the departing account's server ids and only that account's item list ever asks for them. Adjudicated at gate 1 and again at gate 2; recorded here so it stops being re-derived.

- **The review sheet's caption survives its last page.** *"Page 1 is what opens first. Use the arrows to change the order."* renders above zero rows the moment someone deletes their final page — measured on all nine `scan-empty_*` frames. Pre-existing and cosmetic.

- **`DELETE /v1/me` purges scan blobs only `if (deps.scans)`, while `DELETE /v1/score-scans/:id` refuses with 503 first.** A real asymmetry, gated on a misconfigured deployment in which every other scan route already fails loudly. Below the bar as a defect; recorded so it is not re-derived a fourth time.

### From the score-scan Slice 2 stage gate (2026-08-10) — real, deliberately not fixed

- **The page encoder strips the only orientation carrier iOS writes.** Measured: a `.right` image encodes as `orientation=6` with the pixels *not* rotated, and the allow-list then removes APP1 entirely, so it re-reads as an un-rotated `.up` image. Keeping APP1 is not an option — the commit gate refuses it. Whether VisionKit ever hands back a non-`.up` page is unreachable off-device, so this joins the device-pass list with its recipe: log `imageOrientation` before encoding, then `exiftool -Orientation` the downloaded blob. If it does happen, the page is visibly 90° wrong for the owner *and* the recipient, and retaking cannot fix it.

- **`BackgroundUploadLedger` is write-only, and its key cannot name a page.** `hasLanded` has zero callers — already true for lessons before this slice — and one key covers all N pages of a scan. Today that costs one redundant idempotent PUT after a process kill, which the system already pays on every SAS expiry. **If anyone wires it, the key must be extended first**, or a resumed scan will be judged landed on the strength of one page.

- **`taken_down` has no writer.** Nothing in `api/`, `worker/` or `drizzle/` sets it; §13 is unbuilt. The client half is built and renders correctly, so the state exists but cannot arise except by hand-run SQL. Recorded so no future review files a takedown sequence as user-reachable.

- **"Removed from your device when the upload completes" is a founder copy decision, not drift.** §6.1 mandates the row verbatim and §10.2 designs the page cache under `Caches/` four hundred lines later in full knowledge of it: the clause is about the owner's own originals, which *are* deleted on commit. The honest residue is that the row as printed reads as an unqualified device claim, and a regulator-facing reader would take it that way. One clause would close it — design owner's call, not a Slice 2 defect.

### From the score-scan Slice 1 stage gate (2026-08-09) — real, deliberately not fixed

- **The commit's EXIF gate reads the head of the file only.** `api/src/notes/jpeg.ts` stops at SOS, so "carries no APP1/EXIF segment" means "no APP1 *before* SOS"; metadata appended after the scan data survives. Nobody is harmed by it — the only actor who can place trailing bytes in the file is the scan's owner, in their own photograph — so the fix is to narrow §9.3's sentence to what the gate actually checks, not to scan 40 MiB per page. It was raised, verified, and downgraded on that reasoning; do not re-file it as a privacy hole.

- **A deleted scan leaves a 7-day recoverable tail, and that is the design.** The container has `isVersioningEnabled` plus 7-day soft delete, so `deletePrefix` removes the current blobs and leaves versions behind. §11 rule 2 states it and the shipped privacy line already promises exactly this — "recoverable by our operators for up to 7 days". The E2E leg that "found" it was listing without `--include v`; re-run it that way before anyone calls it a leak.

- **The cap redraws an over-cap page and nothing redraws an under-cap one, so orientation is handled two ways.** `ScoreScanPageEncoder.capped` renders through `UIGraphicsImageRenderer`, which bakes `imageOrientation` into the pixels; a page inside the cap goes straight to `jpegData`, whose EXIF orientation the allow-list then strips. Measured 2026-08-11 on a `.right` UIImage: 3024x4032 over the cap comes back 2048x1536, the way round it was taken; 600x800 under the cap comes back 600x800, a quarter turn wrong. Both are pinned by test. **Unreachable while VisionKit is the only producer** — it hands back `.up` — so this is the same latent item as the orientation carrier, now with one of its two paths accidentally correct. Fix both together, by normalising in `capped` for every page, on the day a "choose from Photos" or PDF-import entry point lands.

- **The page encoder is only correct for the source it currently has.** `ScoreScanPageEncoder`'s allow-list strips APP14/Adobe — a CMYK page then renders with inverted colour — and a multi-chunk ICC profile over 64 KiB earns a permanent 415. Both are unreachable while VisionKit is the only producer, because it hands back re-rendered sRGB. **Gate any "choose from Photos" or PDF-import entry point on fixing them**; that entry point is the day both become live.

- **`ScoreScanStore` and `LessonSessionStore` share 62 identical lines on purpose.** Swift forbids static stored properties in generic types, which is where the shared `ioLock` would have to live, and the slice budgeted exactly one refactor of shipped lesson code — `LessonUploader` — so spending it here would have been the wrong one. **Pre-declared extraction trigger:** extract a `FileLedger` when a third ledger appears, or when the `update`/`rawSave` bodies diverge for any reason other than the record type.

- **20 pages no longer reach `MAX_SCAN_BYTES`, and the copy for the case that would still does not exist.** The cap is 40 MiB checked against the *sum* of the pages. The encoder now downscales: `ScoreScanPageEncoder.maxLongEdge = 2048` px on the long edge, aspect kept, never enlarging, a page already inside it byte-identical to what the encoder made before the cap existed. Measured 2026-08-11 by running the shipped encoder over the same nine real photographs of printed scores at a ladder of long edges (`KaraOrcheeAMT/Tests/ScanRealPageMeasurementTests.swift`, sim B7F0BF4C, app at the commit that added the cap; numbers in `KaraOrcheeNotes_v10_Scan_Design/evidence_cap/`):

  | long edge | worst of the nine, per page | × 20 |
  | --- | --- | --- |
  | 1440 (the photographs as supplied) | 428 KB | 8.4 MiB |
  | **2048 — the cap** | **816 KB** | **15.9 MiB** |
  | 2400 | 1032 KB | 20.2 MiB |
  | 2752 | 1256 KB | 24.5 MiB |
  | 4032 | 2155 KB | 42.1 MiB |

  Read every row above 1440 as a **lower bound**: they are the same photographs resampled up, carrying none of the detail a real capture would add. Cross-checked against the detail-packed cost of the native page, 0.282 B/px at q0.8, which puts a real 2048 page at ~887 KB and 20 of them at ~17 MiB — two derivations agreeing on **better than 2× headroom under the cap.**

  **Why 2048 and not the rung above.** No screen in the app draws a page larger than 2570 px (iPad Pro 13-inch; the iPhone 17 Pro draws 1608), both measured off the shipped viewer, and the viewer has no zoom. 2048 is therefore already above every iPhone and 0.80 of the iPad. On a scale model of that shortfall — the 1440 source resampled by the shipped iOS path to the same fraction and viewed back at 1440 — a 2048-class cap keeps the pencil clean and a 1800-class cap visibly softens it, while 2400 buys a difference that is small and costs 27% more bytes. The frames are `evidence_cap/ipadmodel_*.png` and `evidence_cap/shipped_*_pencil.png`.

  **Still open, and what would close it:** the pixel size VisionKit actually returns on the target devices, which is unreachable off-device. It cannot raise the byte risk — anything larger is capped — but it is the only thing that can say whether 2048 leaves detail on the table for a page photographed at sensor resolution and cropped to the paper, which these photographs (background clutter included, ~25% of the frame) are not. **Two sentences are still missing** whatever that number turns out to be: §7 state 6's repair clause ("Delete a page to add another"), and any sentence at all for a full disk. The over-cap sentence is **no longer owed at 20 pages** — but the 413 backstop is still a dead end: `ScanUploader` maps 413 to a stopped upload with "These pages are too large to send." beside a **Try again that can never succeed.** Re-open the copy question if the cap is ever raised, or if a page count above 20 is ever allowed.

- **The nine sample photographs cannot test the EXIF gate, the orientation carrier, or the 64 KiB head — and no sample that arrives by message ever will.** All nine carry APP0/JFIF only, or APP0 + APP2/ICC; none carries APP1, because the transfer that delivered them downscaled to 1080-wide and stripped metadata. All nine decode `imageOrientation == .up`, so they say nothing about the orientation item above either. What they do test is real printed-score content through both halves of the wire, and they are in the conformance corpus as its `photo_*` and `encoded_*` cases. They are also **not** a test of the shipped capture path: they carry background clutter, a finger, glare and page curvature that VisionKit's document detection would crop and de-warp away.

- **`compressionQuality: 0.8` is not shown to be wrong, and the evidence that would settle it does not exist yet.** The question is whether q0.8 destroys the pencil annotation a teacher photographs the page *for*. Measured on a page carrying pencil analysis marks: against the photograph as supplied, q0.8 moves the annotated crops by **MAE 0.40–0.45** of 255, maximum deviation 3 levels, ink depth unchanged. That number is not the answer, because these photographs arrive **already quantised more coarsely than q0.8 applies** — source luma quantisation table mean 27.70 against q0.8's 7.42, and even q0.6's 16.08 — which is also why the encoder's output is *larger* than its input, 422 KB from 284 KB. On content where the quantiser does bind (the same page resampled to half size, against its own q1.00) q0.8 costs **MAE 1.67–1.79 on the pencil crops and 1.74–1.79 on the printed crops**: it treats handwriting and engraving alike, ink depth moving under 2% either way. Grey pencil is carried by luma and the encoder is 4:2:0, so chroma subsampling never reaches it. **Recommendation: leave 0.8 alone.** What would overturn it is a VisionKit capture of an annotated page at sensor resolution — the same device pass the orientation item waits on. The byte item above was settled the other way, on resolution rather than quality, and 0.8 was not touched to do it.

### From the score-scan Slice 3 re-gate (2026-08-12) — recorded here, not fixed with the guards

The re-gate's one FIX-NOW is closed: both attach routes now refuse **409 `note_names_piece`** off the
row (`routes/notes.ts:335-340`, `:920-923`), and §19 of `SCAN_DESIGN.md` states the invariant as a row
property with two enforcement sides. Its four riders are app-side and ride the next app batch. These
are its records.

- **The attach refusal has no sentence in the app yet, and the string it does show is now misleading.** `setScoreScan` discards the error unbound (`NoteReviewSession.swift:378-389`), so a 409 lands as `ScanAttachCopy.attachFailed` — *"Couldn't add these photos to this note. Try again."* — in the strip, in `ScanPickerSheet` (`:156`, which stays up), and via `NoteDetailView.attachScan`'s catch-all on the self-note route. **Try again is now false**: the refusal is permanent while the row names a piece, and the failure path's `refreshScoreScan()` does not repair the divergent `working.pieceId` that drew the offer, so a teacher can retry forever. The server sends a `message` written to be shown verbatim; the app change is to bind `code == "note_names_piece"` and print it, and to gate the Score section on the row rather than on `working.pieceId`. Until then the refusal is honest in effect (no pair is minted) and generic in wording.

- ~~**A `CHECK (piece_id IS NULL OR score_scan_id IS NULL)` is the durable close, and it must wait for the repair.**~~ **Done 2026-08-13** — `ck_note_piece_excludes_scan`, migration `0029`, live on api revision `0000061`. The migration repairs before it constrains, so it needs no separate operator session and applies to a dirty database anywhere. See the recipe section at the top for how it was applied.

- **`markRead` has no origin filter** (S3 gate RECORD 2, never filed). Carried forward unresolved.

- **The author gates the Score section on `working.pieceId`; the student gates on `vm.lesson?.piece`** (S3 gate RECORD 4, never filed, and load-bearing as of this re-gate). `NoteDetailView.swift:180` reads `vm.lesson?.piece`, which `NoteLessonAdapter.swift:26` maps straight from `note.pieceId`, so the two predicates agree **today** — which is the only reason no shipped sequence reached the self-note writer. They are not the same predicate and nothing holds them together. Cite this by its text; the number "RECORD 4" appears in two lens documents and resolves nowhere.

- **`scan_purged` is recorded for D1's sentence only, never for `ownedScanId` accepting such a scan** (S3 gate RECORD 5, half-filed above). `ownedScanId` excludes `taken_down` and nothing else, so a `ready` row with a null `blob_path` is still attachable.

- **The S3 gate's "retract → duplicate accumulates" clause is stale — correct the gate text, not the code.** `routes/notes.ts:747` is `scoreScanId: note.pieceId ? null : note.scoreScanId`, so the duplicate of a piece-bearing note carries no scan.

- **Two evidence-record inaccuracies in `shots_s3b/INDEX.md`.** `:38-40` and `:537-543` publish a sweep over "all nine" frames in a folder holding **ten** — the tenth, `s3b-score-viewer-used_iphone_landscape_dark_ax5`, landed after the sweep and measures 59.80 %, genuine but outside both the count and the published 68.97–79.93 % range. And that folder's rule at `:59`/`:90`, *"no state verdict may rest on an iPhone landscape AX5 frame"*, is over-broad: it generalises from nine Review-screen states, where the footer fills the axis, onto a tenth that is a **viewer** state showing "Shown in 2 notes." whole below the pager. L5's landscape axis is evidenced on disk and disclaimed in the record.

- **Legacy rows: counted at 0, with a recipe that runs from a laptop that cannot reach Postgres.** Postgres refuses connections from developer machines (private networking); only the container app can reach it. `az containerapp exec` is the channel, with two mechanical traps — it needs a **TTY**, so it must be wrapped (`script -q /dev/null az containerapp exec …`), and it **splits `--command` on spaces**, so the payload must arrive as exactly three space-free argv tokens. What works, verified 2026-08-12 against `ca-app-api-dev--0000059` (image `api:6034f0e`, i.e. **before** the guards): base64 the script, then

  ```
  B64=$(base64 < script.js | tr -d '\n')
  script -q /dev/null az containerapp exec -g rg-karaorchee-app-dev -n ca-app-api-dev \
    --command "sh -c echo\${IFS}$B64|base64\${IFS}-d|node"
  ```

  The runtime image is `node:22-alpine` with `pg` in production deps and `DATABASE_URL` in the environment, so `new Pool({connectionString: process.env.DATABASE_URL})` is all the script needs. **Result: `SELECT count(*) FROM notes WHERE piece_id IS NOT NULL AND score_scan_id IS NOT NULL` → 0, of 8 notes total; zero by status and origin.** `rg-karaorchee-app-prod` does not exist, so dev is every environment. **The repair — `UPDATE notes SET score_scan_id = NULL WHERE piece_id IS NOT NULL AND score_scan_id IS NOT NULL;` — was therefore not run, and nothing is owed for it: it is safe only because Slice 4 is unbuilt, so no reader was ever shown these scans and no `score_scan_detached_at` marker is owed.** Re-run the count when the guarded revision deploys: the count above was taken against the unguarded image and every day it stayed open could mint one, and a `sent` row has no API repair path — the SQL is its only exit. Then add the CHECK constraint above.

## Known and accepted — the test that keeps changing shape

- **`NoteReviewKeyboardTests` fails intermittently in the full suite and never in isolation.** Measured on one tree at `2586181`, same simulator, nothing else running: the class passes 2/2 twice when run alone, and the full suite gave 1 failure then 0 failures on consecutive runs. So it is a suite-condition flake — pollution or timing under load — not a defect in whatever change is in flight when it fires.

  **This is the third distinct shape this one class has taken in a week, and each diagnosis was right about a different thing:** first it failed on every run and a bisect showed it failed identically at `a72e7a7`, before any scan work existed; then instrumentation showed its primary assertion path never ran at all — the unit-test host is `.inactive`, no `UIRemoteKeyboardWindow` is ever created, so it had only ever passed by winning a 0.25s-to-8.5s race on `inputAccessoryView`; the rewrite removed that assertion and passed 5/5 plus once under load 158. **All five of those verification runs were single-class runs**, which is exactly the dimension where it still fails.

  **Before spending another hour on it:** run it alone (it will pass), run the full suite twice (it may fail once), and only then look for a cause. Do not attribute a full-suite failure of this class to the change in flight without that comparison — that inference has been wrong twice.

## Verified clean, so nobody re-opens them

- **The score-scan routes are green end to end against the deployed API.** `tools/scan_e2e/smoke.py`, 14/14 on revision `0000056`: create, a duplicate create handing back the same row, two page uploads, commit, **a second commit answering 200 rather than 409**, detail with an empty usage list, a non-image page refused with **its page number named**, an EXIF page refused, three deletes, and a deleted scan answering 404. Several of those are gate fixes proven for the first time against a real server rather than a test double.

- **`GET /v1/me` does not exist — do not read its 404 as "this account has no Notes user".** `/v1/me` is DELETE-only (`routes/users.ts:202`); a GET falls through to Express's catch-all and 404s for every caller, signed in or not. An earlier entry here claimed the batch-tools admin identity had no `users` row on that evidence and filed a throwaway dev account as a blocker; the admin token in fact answers `GET /v1/score-scans` with 200 and its own prior scans. The blocker was never real. Use a route that exists when probing whether a credential works.



- **The model does not invent bar numbers.** A lesson with zero spoken bar numbers but 24 spoken numerals (a teacher counting beats) produced 5 annotations and 0 placements; one annotation quoting "One, two, three. On each beat you have one note." was classified as a deixis reference, not a bar.
- **Authenticated responses carry `no-store` and `Vary: Authorization`**, set in `requireAuth` so every future authenticated route inherits them. Verified against the deployed revision, not only in tests.
