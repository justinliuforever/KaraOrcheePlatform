# KaraOrcheePlatform
Instructions for coding agents. Claude Code reads this through the `@AGENTS.md` import
at the top of CLAUDE.md; other tools read it directly.

## Cross-repo contracts

- `worker/notes/narration_parity.json` is the one canonical narration contract; worker, API and app all *reference* (never copy) it, clips are looked up by a hash of the spoken text, and any wording drift silently stops playback with no error anywhere.
- Narration clips are one file shared by every device, so their wording must never depend on whether a particular device's engraving can place a bar.
- `PUBLISH_ROLES` is duplicated in the Python worker and the TypeScript API; drift silently drops or leaks an artifact role from the immutable published bundle.
- The push payload is a byte-for-byte contract between `api/src/notes/push.ts` and the app's decoder.
- Annotation locations are **printed** bar numbers; the app's model is zero-based engraving index; the two genuinely diverge in shipped content (Liszt printed 92–94 = index 93–95; any anacrusis or inserted bar); `NoteLessonAdapter` is the single conversion point and an unresolvable bar becomes UNPLACED, never index 1.
- The app ships ahead of its matching API version (dev today, every TestFlight window), so both sides must tolerate skew: missing fields stay absent, never invented, never fatal.
