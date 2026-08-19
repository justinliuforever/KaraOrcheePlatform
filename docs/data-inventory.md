# KaraOrchee Notes — Data Inventory, Data Flow, and Vendor List

**Product:** KaraOrchee Notes (iOS app + Azure platform) · **App version:** 0.10 (build 3) · **As of:** 2026-08-18

Labels used below: **Current** = live today. **Planned** = built but switched off. **Need to verify** = governed by a vendor's own terms, not by our systems.

**Scope.** The Notes product: the iOS app and its Azure platform. Section 8 covers a separate data path in the same iOS binary (practice score-following) that is in scope for App Store privacy labels. The older KaraOrchee web system shares an authentication tenant with this product and nothing else — no database, no storage, no code.

**Everything described here runs in the development environment. There is no production resource group yet, and the 0.10 build points at the dev API.** Creating one is a prerequisite for App Store submission (§17).

---

## 1. Architecture and data flow

```
                    ┌──────────────────────────────────────────────────────────┐
                    │  iPhone / iPad  (KaraOrchee Notes)                       │
                    │  records lesson → LPCM CAF on local disk                 │
                    │  photographs score → JPEG pages, EXIF/GPS stripped       │
                    └───────────┬──────────────────────────────┬───────────────┘
                                │ HTTPS                        │ HTTPS
                                │ (bearer access token)        │ (per-blob write-only SAS)
                                ▼                              ▼
        ┌───────────────────────────────────┐   ┌───────────────────────────────────────┐
        │  API — Azure Container Apps       │   │  Azure Blob Storage  stkaraoappdev    │
        │  ca-app-api-dev                   │──▶│  lesson-audio/    (raw audio)         │
        │  validates CIAM access token      │   │  score-scans/     (JPEG pages)        │
        │  mints short-lived scoped SAS     │   │  notes-assets/    (transcript, TTS)   │
        └───────────┬───────────────────────┘   └────────────┬──────────────────────────┘
                    │ Service Bus  notes-jobs                │  60-min read SAS
                    ▼                                        ▼   minted per job
        ┌───────────────────────────────────┐   ┌───────────────────────────────────────┐
        │  Worker — ca-notes-worker-dev     │──▶│  AssemblyAI   (speech → text)         │
        │  1. ASR   2. gates   3. LLM       │   │     downloads the audio via that SAS  │
        │                                   │──▶│  Anthropic    (transcript → notes)    │
        │                                   │──▶│  ElevenLabs   (note text → speech)    │
        └───────────┬───────────────────────┘   └───────────────────────────────────────┘
                    │ writes note + annotations
                    ▼
        ┌───────────────────────────────────┐
        │  PostgreSQL  pg-karaorchee-app-dev│──▶  back to the device over the authenticated API
        └───────────────────────────────────┘
```

One Azure subscription, one region (Central US), one resource group `rg-karaorchee-app-dev`. The only exception is the practice-feedback container in §8: a separate storage account in `rg-karaorchee-amt`, East US.

---

## 2. Authentication

**Microsoft Entra External ID (CIAM).** Current.

The questionnaire assumes "Email + Password". The primary factor is actually an emailed one-time code; a password is optional and secondary.

| | |
|---|---|
| Provider | Microsoft Entra External ID, Microsoft-hosted. Client SDK is MSAL for iOS 1.9.0 — the only third-party package in the app. |
| Primary sign-in factor | Email one-time passcode, sent by Microsoft. |
| Password | Optional, set after code verification. Policy enforced Microsoft-side: at least 8 characters and at least 3 of upper/lower/digit/symbol. |
| Where passwords are stored | Microsoft only. They never reach our API, database, or logs. |
| Hashing | Microsoft's, inside the CIAM tenant. We neither implement nor configure it. |
| Email verification | Microsoft sends the code. We send no email of our own. |
| Password reset | Microsoft's CIAM reset flow, also by emailed code. |
| Token storage on device | MSAL's keychain cache (iOS Keychain). Only our custom API scope is requested, never Microsoft Graph scopes. |
| Server-side validation | JWT verified against the CIAM JWKS endpoint, checking issuer and audience. |
| **Can KaraOrchee see a password?** | **No.** No code path in the app or API receives, transmits, stores, or logs one. |
| Account lockout | The tenant's, on thresholds Microsoft does not publish to us. |

---

## 3. Raw lesson audio

```
Record → local disk (LPCM CAF) → [user taps Send] → Azure Blob lesson-audio/
  → Service Bus → worker mints 60-min read SAS → AssemblyAI downloads it
  → transcript returns → audio remains until the 90-day lifecycle deletes it
```

| | |
|---|---|
| Local first, or streamed? | Local first. Written to the device as it records; uploaded only when the user sends. Nothing is streamed live. |
| Format | 16 kHz mono 16-bit Linear PCM in a CAF container. Uncompressed so a file killed mid-lesson stays decodable. |
| Destination | Azure Blob Storage, account `stkaraoappdev`, container `lesson-audio`. |
| Authorisation | A per-blob, write-only, time-limited SAS (create+write; no read, no list), scoped to one blob. The device uploads directly to storage — audio does not pass through our API server. |
| Encrypted in transit | Yes. HTTPS only; TLS 1.2 minimum; public blob access disabled. |
| Encrypted at rest | Yes. Azure Storage Service Encryption with Microsoft-managed keys. |
| Our services that receive full audio | The worker, which hands a URL to the transcriber. The API mints URLs but never reads audio bodies. |
| Third parties that receive full audio | **AssemblyAI only.** No other vendor ever receives lesson audio. |
| Retention | **90 days from upload**, then deleted automatically. Moved to Cool storage at 30 days. |
| Earlier deletion | Discarding a lesson deletes the audio immediately, as does deleting the account. |
| Survives deletion in backup? | Recoverable by an operator for **7 days** (blob soft-delete), then gone. Superseded versions purge at 7 days. |
| Internal access | Requires the storage account key — today, the founder's Azure account. The admin console exposes no audio and has no download-audio route (§15). |

The app tells users: *"The recording and its transcript are deleted 90 days after your notes are made — sooner if you delete the lesson or your account. The written notes themselves remain."* This matches the infrastructure. One nuance: the Azure clock runs 90 days from upload rather than from note creation, and since notes are generated within minutes of upload, the Azure clock is the earlier of the two — the product never keeps audio longer than it promises.

---

## 4. Transcript

| | |
|---|---|
| Generated by | **AssemblyAI**, models `universal-3-5-pro` / `universal-2`, speaker diarisation on. Third-party API; we host no ASR model. |
| What is sent | A 60-minute read URL to one audio blob, plus model options. No name, no email, no piece metadata. The blob path is `{userId}/{lessonId}.m4a`, so **the URL carries our internal user and lesson UUIDs** — opaque identifiers the vendor cannot resolve, but identifiers nonetheless. |
| Where our copy lives | Azure Blob, `notes-assets/transcripts/` — JSON holding the text, diarised utterances, detected language, and duration. |
| Vendor's copy | **We issue an explicit delete** once ours is durably stored; this also retires the audio reference we handed over. Best-effort by design, so it can never fail a job. Vendor-side TTL as backstop: **Need to verify**. |
| Sent onward to another AI provider? | Yes — to Anthropic, for note generation (§5). Nowhere else. |
| Retention | **90 days**, same clock as the audio. The AI's raw output is stored under the same prefix so it expires together. |
| Deleted with the account | Yes, explicitly (§11). |
| Backup | Blob soft-delete 7 days; superseded versions purge at 30 days. |

A transcript is the recording in another encoding — verbatim speech, often a minor's. It is deliberately governed by the same retention rule as the audio rather than treated as ordinary derived text.

---

## 5. AI-generated lesson notes

**Anthropic, model `claude-sonnet-5`.** Current.

Every job records the model that produced it. Across all real jobs in the database: **7 on `claude-sonnet-5`, 0 on any other model** (one job failed before reaching the LLM).

### Complete list of what Anthropic receives

| Field | Sent | Form |
|---|---|---|
| Full transcript | Yes | Diarised turn lines: `Speaker A: …` / `Speaker B: …` |
| Transcript chunks | No | Sent as one document |
| Student name | No | |
| Student email | No | |
| Teacher name | No | |
| Teacher email | No | |
| Repertoire / composer / title | Yes | One string: `"Title" by Composer`, or the free-text piece name typed by the user, or `a piece not in our catalog` |
| Measure numbers | Yes, one integer | The score's total measure count, used only to bound what the model may output |
| MusicXML | No | |
| Scanned score / PDF / any image | No | The model never receives an image |
| Student ID / Teacher ID / Lesson ID | No | |
| Previous lesson notes | No | Each lesson is processed in isolation |
| Practice history | No | |
| Any other metadata | No | |

**The caveat that belongs in any legal review:** no name is sent as a field, but the transcript is verbatim speech and teachers say students' names aloud during lessons. Names, and any other personal detail spoken in the room, can therefore appear inside the transcript text sent to AssemblyAI and Anthropic. Speaker labels themselves are anonymous.

### DeepSeek fallback

The worker retries Anthropic twice, then falls back to **DeepSeek** (`deepseek-v4-pro`) if a DeepSeek key is configured. **It is configured on the live worker.** So although DeepSeek has never processed a lesson, an Anthropic outage would send full verbatim lesson transcripts, including minors' speech, to a China-hosted provider under different governing law from every other vendor here, with no separate user consent.

Removing the environment variable disarms it and requires no code change — an absent key already means "no fallback, fail the job cleanly". See §17.

---

## 6. Read-aloud narration

**ElevenLabs.** Current, live — 84 clips generated.

Notes can be read aloud in a synthetic voice.

| | |
|---|---|
| What is sent | The text of the practice note — the same sentences shown on screen — plus a voice id and fixed synthesis settings. |
| What is not sent | No audio, no transcript, no email, no identifier, no name field. |
| Same caveat as §5 | Note text includes quotes copied verbatim from the lesson. A student's name spoken inside a quoted sentence travels with it. |
| Model | `eleven_multilingual_v2` |
| Where results are stored | Azure Blob, `notes-assets/narration/`. |
| Retention | No time-based expiry. Narration is machine-spoken note text, not a recording of a person, so it lives and dies with its note — purged on note, lesson, or account deletion. |

---

## 7. Score photos

```
Camera (Apple VisionKit) → on-device crop/filter → JPEG, metadata stripped
  → per-page write-only SAS → Azure Blob score-scans/ → server commits the scan
```

| | |
|---|---|
| On device or uploaded raw? | **Fully on device.** Capture uses Apple's `VNDocumentCameraViewController`; library imports get the same crop rebuilt from Apple's on-device Vision primitives. Edge detection, perspective correction, filtering and downscaling all happen on the phone. |
| Third-party OCR or scanning service | **None.** No cloud OCR exists in the codebase. No third party ever receives a score image. |
| Is there OCR at all? | No. We store page images; we do not extract text from them. |
| Stored as PDF? | **No — as JPEG pages** (the questionnaire assumed PDF). Quality 0.8, long edge capped at 2048 px. |
| Location data | **Stripped before upload.** The encoder keeps only the JFIF and ICC-profile markers and discards everything else, including the EXIF block carrying GPS. The server independently enforces the same allow-list on commit, so a page with EXIF is rejected rather than stored. |
| Where stored | Azure Blob container `score-scans`. |
| Also on device? | Originals stay on the device until the upload commits, then are removed. Pages downloaded for viewing sit in `Caches/`, which iOS may reclaim at any time. |
| Sharing permissions | A scan belongs to the account that took it, and becomes visible to the other party only by being attached to a specific note or lesson, for as long as that attachment and that account exist. |
| When the relationship ends | The link is marked removed; the scan is not deleted and stays with its owning account. A scan on a note the student received remains visible only while the owner keeps it. |
| Automatic deletion | **None.** A 365-day rule exists in our infrastructure template but is disabled in the live account. Score photos persist until a user deletes them or their account. Two narrower rules are live: abandoned uploads swept at 1 day, superseded versions at 7 days. |

---

## 8. Second data path in the same app: practice score-following

Not asked in the questionnaire, but in the same binary and therefore in scope for privacy labels. Entirely separate from Notes — different storage account, different resource group, no shared database.

Practice mode listens to the piano through the microphone to follow the score. **That listening is on-device; ordinary practice uploads nothing.**

There is, however, a consent-gated diagnostic upload: when a user finishes a session and chooses "Send feedback", the app uploads that session's bundle — including the **raw captured microphone PCM** — plus a small JSON of their rating, free-text comment, and a self-typed tester name.

| | |
|---|---|
| Gate | Only sessions carrying an explicit consent marker written when the user submits the feedback sheet. Unconsented sessions are pruned locally after 7 days. |
| Destination | Azure Blob, account `stkaraorcheeamt`, container `feedback`, resource group `rg-karaorchee-amt`. Not the Notes storage account. |
| Identifiers attached | An app-generated install UUID, Apple's `identifierForVendor`, and the tester name if typed. No account email or user id. |
| Retention | None configured. |
| **Finding** | The shipped 0.10 bundle contains a plist holding the container SAS URL; anyone who obtains the IPA can extract it. Its power is bounded — the stored access policy grants **create and write only, no read and no list**, so it cannot be used to read anyone's data. But its expiry is 2099-12-31, effectively never. See §17. |

---

## 9. Where every category of user data lives

| Category | Database | Object storage | Local device | Cache | Backup |
|---|---|---|---|---|---|
| User / profile (email, display name, optional studio name, role flags, self-reported age bracket over_13 / under_13) | Postgres `users` | — | UserDefaults (role flag only) | — | PG 35d |
| Sign-in identity and credentials | **Microsoft Entra External ID**, not ours | — | MSAL keychain (tokens) | — | Microsoft's |
| Teacher–student relationship | `teacher_student_links`, `invites` | — | UserDefaults (roster cache) | — | PG 35d |
| Lesson metadata | `lesson_sessions`, `note_jobs` | — | Documents | — | PG 35d |
| **Raw lesson audio** | path only | `lesson-audio/` | until upload completes | — | soft-delete 7d |
| **Transcript** and raw model output | path only | `notes-assets/transcripts/` | — | — | soft-delete 7d |
| AI notes, practice plans, annotations | `notes`, `note_annotations` | — | Documents (draft journal) | — | PG 35d |
| Teacher edits | same rows | — | Documents (draft journal) | — | PG 35d |
| Student comments / questions | Postgres | — | — | — | PG 35d |
| Practice tasks / completion | Postgres | — | — | — | PG 35d |
| Read-aloud audio | `note_narration_clips` | `notes-assets/narration/` | — | `Caches/` | soft-delete 7d |
| **Score photos** | `score_scans` metadata | `score-scans/` | until upload commits | `Caches/` | soft-delete 7d |
| MusicXML (published catalogue scores) | `pieces` | `piece-bundles/`, `piece-sources/` | downloaded bundles | — | soft-delete 7d |
| Subscription / payment | `entitlements` (trial flags only) | — | — | — | — |
| Service logs | — | — | — | — | Log Analytics 30d |
| Practice-feedback bundles (§8) | — | `stkaraorcheeamt/feedback` | until uploaded | — | none |

**Subscription and payment are not implemented.** No StoreKit, no in-app purchase, no payment processor, no teacher-payout mechanism anywhere. The `402` the API can return is our own server-side entitlement gate on a trial flag, not a billing integration.

**Profile images** are not implemented — the app has no avatar upload.

---

## 10. Retention summary

| Data | Retention | Automatic |
|---|---|---|
| Raw lesson audio | 90 days from upload; Cool at 30 days | Yes |
| Transcript and model output | 90 days | Yes |
| Score photos | **Indefinite** until user deletion — the 365-day rule is disabled | No |
| Abandoned scan uploads | 1 day | Yes |
| Read-aloud clips | Life of the note | With the note |
| Notes, plans, annotations | Life of the account holding them; a **sent note stays with the student** | No |
| Deleted blobs (recovery window) | **7 days** for a file; 37 in the worst case, below | Yes |
| Postgres backups | **35 days**, geo-redundancy disabled | Yes |
| Service logs | 30 days | Yes |
| Vendor-side copies | AssemblyAI: we issue an explicit delete per transcript. Anthropic / ElevenLabs / DeepSeek: **Need to verify** | — |

**On 7 days versus 37.** The published privacy notice says deleted files are operator-recoverable "for up to 37 days". Both numbers are correct and answer different questions. When a *file* is deleted — what happens on lesson discard, note deletion, or account deletion — blob soft-delete keeps it recoverable for **7 days**. The 37 is the worst case if an entire *container* were deleted: container soft-delete holds it 30 days, and a file inside could still carry its own 7-day window. The user-facing figure is the conservative upper bound. **For every deletion a user can actually trigger, the answer is 7 days.**

---

## 11. Account deletion

**Implemented and working today**: in-app, immediate, no email round-trip. `DELETE /v1/me`. The ordering is deliberate — the platform purge runs before the identity is deleted, so a failed purge can never orphan data nobody can authenticate to retry.

| Category | Outcome |
|---|---|
| Account / profile row | **Soft — tombstoned.** The row survives with status `deleted`; email, display name, studio name, and all trial and consent timestamps set to NULL; the Entra object id moves to a write-once column so the account cannot be resurrected by signing in again. |
| Email | Immediately nulled. |
| Sign-in identity | **Deleted at Microsoft** via Graph. If Graph does not answer, the app says so and the tombstone drives a retry. Microsoft purges its own copy within 30 days. |
| Teacher–student relationship | Soft — marked removed with a timestamp. Invites are revoked and their free-text label, which often names a child who never signed up, is nulled. |
| Raw audio | **Immediately deleted**, 3 attempts, failures logged by path. |
| Transcript and model output | **Immediately deleted.** |
| AI notes received by this user | **Immediately deleted**, with annotations. |
| AI notes drafted by this user | **Immediately deleted**, with annotations. |
| AI notes already **sent** by this teacher | **Retained.** A sent note is the student's copy and the lasting record of their lesson; it survives, attributed to the tombstone. Deliberate, and disclosed in-app. |
| Teacher edits | Deleted or retained with the note they belong to. |
| Student comments / questions | Deleted with their notes. |
| Practice history | Deleted with the notes. |
| Score photos | **Immediately deleted** — rows and blobs. |
| Read-aloud audio | **Immediately deleted** for every purged note. |
| Custom piece entries | Deleted. The free-text piece label students see is a separate column and is untouched. |
| Push device tokens | **Immediately deleted.** |
| Entitlements | **Immediately deleted.** |
| Locally downloaded files | Cleared on the device by the app's sign-out/delete path; files in `Caches/` are reclaimed by iOS. |
| Analytics records | **None exist** (§13). |
| Payment / subscription records | **None exist** — not implemented. |
| Backups | Retained for their window: deleted blobs 7 days, Postgres 35 days. Not user-visible; they expire on their own. |
| Logs | Retained 30 days. The request logger is written never to record email, display name, request bodies, query strings, or client IPs. Audit rows do carry the acting user id. |
| Audit trail | **Retained by design** — an `account.delete` event is written and audit history is deliberately not self-erasing. |

**Students who record their own lessons are covered.** The purge collects audio and transcripts by the lesson's owning user id, and a solo lesson stores the recording student as that owner — so a student deleting their account purges their own recordings on the same terms as a teacher.

---

## 12. On-device storage

| What | Where | Sign-out | Uninstall | Account deletion |
|---|---|---|---|---|
| Auth tokens | iOS Keychain (MSAL) | MSAL account removed | **Keychain items can survive uninstall on iOS** — platform behaviour | Removed |
| Unsent lesson recordings | Documents | **Deliberately kept** — an accidental sign-out must never destroy an unsent recording | Removed with the app | Removed |
| Unsent note drafts | Documents (per-account journal) | **Deliberately kept**, same rule | Removed with the app | Removed |
| Upload ledger | Documents | Kept | Removed | Removed |
| Score photos pending upload | Documents | Kept | Removed | Removed |
| Score pages for viewing | Caches | Cleared | Removed | Removed |
| Read-aloud clips | Caches | Cleared | Removed | Removed |
| Catalogue cover images | Caches | Cleared | Removed | Removed |
| Roster cache, role flag, player preferences, seen-markers | UserDefaults | Cleared | Removed | Removed |
| Practice-session bundles awaiting upload (§8) | Documents | Kept | Removed | Removed |

---

## 13. Analytics, crash reporting, tracking

**None.**

The app's entire third-party dependency graph is one package: MSAL for iOS 1.9.0. There is no Firebase, Crashlytics, Sentry, Amplitude, Mixpanel, AppsFlyer, Adjust, Branch, Meta or Google SDK; no session replay; no advertising identifier use; no behavioural tracking.

| Category | Present |
|---|---|
| Product analytics | None |
| Usage analytics | None |
| Crash reporting | None — not even Apple's, beyond what a user opts into with Apple directly |
| Performance monitoring | None in the app. Server-side, Container Apps ships console logs to Log Analytics (30 days). |
| Logging | Server-side only, written to exclude PII |
| Attribution / advertising | None |
| Behavioural tracking | None |
| Session replay | None |

**Exceptions that are not SDKs and must still be declared on the privacy label:** the §8 practice-feedback upload sends an install UUID and `identifierForVendor` alongside a consented diagnostic bundle. That is first-party collection.

**Two Azure resources an auditor will see, so they are not mistaken for hidden telemetry:**

- `appi-karaorchee-app-dev` (Application Insights) is provisioned but connected to nothing. No instrumentation key, connection string, or SDK reference exists in the app, API, or worker. It collects nothing.
- `ag-karaorchee-ops` sends one operational email to the founder when the Service Bus dead-letter alert fires. Sent by Azure Monitor, carrying queue metrics only. No user data; no user is ever a recipient.

---

## 14. Push notifications and email

### Push — built, switched off

| | |
|---|---|
| Provider | **Apple APNs directly** — HTTP/2 with a signed JWT. No Firebase, no Azure Notification Hubs, no third party. |
| Live? | **No.** Off at three independent points: the client feature flag is false, the server flag `PUSH_ENABLED` is not set, and no APNs credentials are configured on the deployed API. |
| What a payload would contain | A fixed alert string plus a note id — no note content, no piece title, no names. A lock screen is readable by whoever is nearby, and this is a minor's lesson record. |
| Device tokens | Postgres `devices`; deleted on account deletion. |

### Email — we send none

**KaraOrchee operates no email service.** No SendGrid, Mailgun, Postmark, Amazon SES, Azure Communication Services, or SMTP client anywhere in the platform.

| Email | Sent by | Contains |
|---|---|---|
| Sign-up verification code | **Microsoft** (Entra External ID) | Email address, one-time code |
| Password reset code | **Microsoft** | Email address, one-time code |
| Student invitation | **Nobody** — invitations are short codes typed into the app, or a link the teacher shares by whatever means they choose | — |
| "Lesson ready", student question, subscription notices | **Not implemented** | — |

Microsoft Graph is used for exactly one thing: deleting a CIAM identity when a user deletes their account.

One thing that looks like an exception and is not: the `invites` table carries a `sent_to_email` column and a `created_via` value of `email_invite`. These are unused placeholders for a path that was never built — no code writes either, and no code sends mail.

---

## 15. Internal access and security

| | |
|---|---|
| Admin dashboard | Yes — a web console, CIAM-authenticated against the same tenant, then gated on an admin flag on an active user row. Fail-closed: unknown user, non-admin, or non-active all get 403. |
| Role-based access control | Yes, and **transcript access is a second grant beyond admin**. |
| Break-glass on transcripts | To read a transcript an operator must hold the transcript-access grant, supply a written reason of at least 10 characters, and accept that the access is recorded. List views never return transcript bodies. |
| Who holds it today | 7 admin accounts; 2 hold transcript access; 9 user rows total (development environment). |
| Audio access | The admin console has **no** route returning lesson audio. Reaching raw audio requires the storage account key — today, the founder's Azure account. |
| Audit logs | Yes — every admin action writes a row with the acting user id, the target, and a request id tying it to the service logs. |
| Access logs | Log Analytics, 30 days, PII-excluding by rule. |
| Database reachability | Postgres 16 Flexible Server. **Public network access is enabled**, with two firewall rules: the founder's office IP, and "allow Azure services". Credentials are still required. |
| MFA for production/admin access | **Need to verify** — an Entra tenant policy rather than an application setting. Should be confirmed and, if absent, enforced before launch. |
| Secrets | Container Apps secrets and Azure-managed keys. One documented exception to our API-key convention: Log Analytics accepts Entra auth only, so that path uses a managed identity. |

---

## 16. Third-party vendors

Every external service that can touch user data.

| Vendor | Purpose | Data sent | Retention / training | In production now |
|---|---|---|---|---|
| **AssemblyAI** | Speech-to-text | A 60-min read URL to one audio blob; it downloads and transcribes **the full raw lesson audio**. No name, email, or piece metadata; the URL path carries our internal user and lesson UUIDs. | We explicitly delete their transcript once ours is stored. Their own backstop TTL and training policy: **Need to verify** | **Yes** |
| **Anthropic** | Generating the practice notes | Diarised transcript text; piece title and composer; one integer measure count. Nothing else. Spoken names may appear inside the transcript. | **Need to verify** in writing — Anthropic's published commercial policy is not to train on API inputs, but confirm for the record | **Yes** — 7 of 7 jobs |
| **DeepSeek** | Availability fallback for note generation | *Would be* identical to the Anthropic payload, full verbatim transcript included | **Need to verify.** China-hosted; different governing law from every other vendor here | **Never invoked (0 jobs) — but armed.** The key is on the live worker, so an Anthropic outage triggers it. §5, §17 |
| **ElevenLabs** | Text-to-speech for read-aloud | The text of the practice note only. No audio, transcript, or identifier. | **Need to verify** | **Yes** — 84 clips |
| **Microsoft — Entra External ID** | All authentication; all verification and reset email | Email address, display name, password if set | Until account deletion; Microsoft purges within 30 days | **Yes** |
| **Microsoft Azure** — Container Apps, Blob Storage, PostgreSQL, Service Bus, Log Analytics | Hosting, storage, database, queueing, logging (Central US) | Everything in §9 not held on the device | §10; encrypted at rest with Microsoft-managed keys | **Yes** (dev environment) |
| **Apple — APNs** | Push delivery | Device token, fixed alert string, note id. Nothing is sent today. | — | **No** — disabled at three points |
| **Apple — VisionKit / Vision, PhotosPicker** | Document capture, crop, perspective correction | **Nothing leaves the device.** On-device frameworks only. | — | Yes, as on-device processing |
| **Microsoft — MSAL for iOS 1.9.0** | Authentication client; the app's only third-party SDK | Authentication traffic to the CIAM tenant only | — | **Yes** |

**Not used, stated affirmatively:** no CDN in front of user data; no payment processor; no subscription-management vendor; no teacher-payout vendor; no customer-support platform; no analytics, crash-reporting, attribution, or advertising vendor of any kind.

---

## 17. Gaps to close before App Store submission

1. **There is no production environment.** Everything above is the dev resource group, and the 0.10 build points at the dev API. Production — its own database, storage, secrets, and CIAM application — is a prerequisite, and the findings below should be settled there rather than retrofitted.

2. **Disarm or disclose the DeepSeek fallback.** It is configured on the live worker and would receive full lesson transcripts of minors during an Anthropic outage. Removing the environment variable is one command and needs no code change.

3. **The practice-feedback SAS in the shipped bundle** (§8) is write-only, so no data is readable through it, but it never expires and is extractable from the IPA. Decide whether that upload path ships to the App Store at all; if it does, give the stored access policy a real expiry and a rotation plan.

4. **Score photos have no retention limit.** The 365-day rule exists but is disabled, so photographs of copyrighted sheet music accumulate indefinitely. Both a privacy and a licensing question, and it should be a decision rather than a default.

5. **Postgres public network access is enabled**, with an office-IP rule and "allow Azure services". Production should use private networking.

6. **Confirm MFA is enforced** on the Entra tenant for admin and Azure access.

7. **Get vendor terms in writing** for AssemblyAI, Anthropic, and ElevenLabs — specifically retention and whether inputs may be used for model training. Every "Need to verify" in §16 is one of these.

8. **Under-13 accounts.** The age bracket is self-reported at sign-up and stored, but nothing follows from it. Given that the product's subject is children's music lessons, the COPPA path — verifiable parental consent, and what an under-13 account may do — needs a decision before submission.

9. **A public privacy policy URL is required by App Store Connect.** The in-app "Privacy & data" screen exists and is thorough, and states it is published verbatim at `karaorchee.com/privacy`. Confirm that page is live and current at submission.
