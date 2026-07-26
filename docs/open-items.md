# Open items

Everything decided-but-unbuilt, built-but-unapplied, or deliberately deferred. Updated 2026-07-26.

Nothing here is forgotten work — each line says who it waits on and what unblocks it. Delete a line when it lands, do not let it rot into "we should probably".

---

## Waiting on the founder

| Item | What is blocked | Notes |
|---|---|---|
| **APNs key** | No push notifications reach anyone | Everything else is built and deployed. Steps and rotation in `docs/runbooks/secret-rotation.md`. Without the key the API sends notes exactly as today — no crash, no failed send. |
| **Transcript 90-day retention** | The app tells users cloud audio is deleted at 90 days; a transcript is that recording in another encoding and currently never expires | The rule is written in `infra/main.bicep` (`notes-transcripts-delete`) but **not applied**, because switching it on starts expiring transcripts that exist today. Needs a yes. |
| **Prompt: forbid elided quotes** | ~15% of annotations are discarded | Measured, not guessed: the verbatim-quote gate drops an annotation when the model joins non-adjacent phrases with `...`, and that was the *only* loss mechanism observed in a real run — 2 of 13, both from that cause, one carrying the run's only unconverted bar number. One sentence in `worker/notes/prompt.py` RULES. Cost: the prompt was three-way verified and would need re-verification. |
| **App version bump** | Nothing | 0.8 recommended (Notes is a new product surface, not a point fix). Founder said: decide at archive time. Build number must also increment or TestFlight rejects the upload. |
| **Narration cool-tiering** | Nothing — cost only | `notes-narration-cool` is in bicep, not applied. Cold-tier reads cost extra, so this may cost more than it saves if students revisit old notes. Revisit with real replay data. |

## Hard gates before the first external TestFlight build

| Item | Why it blocks |
|---|---|
| **Dual-role routing** | An account holding both capabilities resolves to the teacher home forever. Documented deferral; must not ship to strangers. |
| **Custom domain** | `PlatformConfig.swift` hardcodes the Azure container-app hostname. Fine for us, wrong for an external build. |
| **Geo-redundant Postgres backup** | Creation-time only — it cannot be enabled on an existing server. Must be set when the prod database is created. |

## Deliberately not doing yet

| Item | Why not, and what would change it |
|---|---|
| **StoreKit / paywall** | Two notes and five users. Prices are decided; building against no usage is not. Revisit when there is a cohort to charge. |
| **The teacher's real voice per annotation** | The worker half is a cheap deterministic derivation from timings we already store — which is the trap. There is no read path for lesson audio, no behaviour designed for when the audio ages out, and a consent question that is not an engineering call: a student consented to being *recorded*, not to the recording being replayed on demand. If it ever starts, start with self-recorded notes, where the voice belongs to the listener. |
| **Placing as a third score-tab mode** | Strictly better than the modal sheet, and premature until we know placing is the bottleneck. |
| **A labelled-step LLM pass** | Would give steps names instead of numbers. Conditional on the founder disliking numbered steps in real use. |
| **Another adversarial review of the note player** | It shipped with one. The last two field tests each produced defects no review had found. Founder time beats another review pass. |

## Known and accepted

- **iOS reclaiming `Caches/` is indistinguishable from never-generated narration.** Our own reaper leaves a marker so it reports `evicted`; the OS leaves nothing. Accepted.
- **`StudentNotesModel.warmNarration`** keeps a per-session "already asked" set that does not consult the reaped marker, so a note evicted mid-session is not re-warmed on arrival until relaunch. The player's own prefetch is the second chance. Not a live defect.
- **`pytest notes/tests pieces` in one invocation fails at collection** — the notes conftest stubs azure modules globally and poisons pieces' imports. Pre-existing. Run the two suites separately.
- **Our narration character count is not the vendor's bill.** ElevenLabs meters credits at a rate that moved from 0.50 to 0.55 per character between July runs and that none of its own endpoints report. We now record the vendor's own number per clip alongside ours; ours remains the pre-flight ceiling because it is the only figure knowable before a request.

## Verified clean, so nobody re-opens them

- **The model does not invent bar numbers.** A lesson with zero spoken bar numbers but 24 spoken numerals (a teacher counting beats) produced 5 annotations and 0 placements; one annotation quoting "One, two, three. On each beat you have one note." was classified as a deixis reference, not a bar.
- **Authenticated responses carry `no-store` and `Vary: Authorization`**, set in `requireAuth` so every future authenticated route inherits them. Verified against the deployed revision, not only in tests.
