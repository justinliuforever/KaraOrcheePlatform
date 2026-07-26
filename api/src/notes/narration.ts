// Blob layout shared verbatim with the synthesis worker and the iOS client:
// notes-assets/narration/<noteId>/<voice>/<clipId>.mp3, clipId = "overview" or an
// annotation id. Changing it here breaks all three.
export const NARRATION_VOICES = ["jessica", "george"] as const;
export type NarrationVoice = (typeof NARRATION_VOICES)[number];

export const DEFAULT_NARRATION_VOICE: NarrationVoice = "jessica";
export const NARRATION_OVERVIEW_CLIP = "overview";
// Exactly what the vendor returns — the worker does not transcode.
export const NARRATION_CLIP_EXT = ".mp3";
// Its own lane, consumed by worker/notes/main.py on its own thread: a minutes-long
// synthesis run may not sit in front of an ASR job on notes-jobs.
export const NARRATION_QUEUE = "notes-narration";

export function isNarrationVoice(value: string): value is NarrationVoice {
  return (NARRATION_VOICES as readonly string[]).includes(value);
}

// Whole note when voice is omitted — that is the deletion unit.
export function narrationPrefix(noteId: string, voice?: NarrationVoice): string {
  return voice ? `narration/${noteId}/${voice}/` : `narration/${noteId}/`;
}

export function narrationClipPath(
  noteId: string,
  voice: NarrationVoice,
  clipId: string,
): string {
  return `${narrationPrefix(noteId, voice)}${clipId}${NARRATION_CLIP_EXT}`;
}
