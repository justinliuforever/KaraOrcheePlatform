import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NARRATION_CLIP_EXT,
  NARRATION_OVERVIEW_CLIP,
  NARRATION_QUEUE,
  NARRATION_VOICES,
  narrationClipPath,
} from "../src/notes/narration";

describe("publish-roles parity (worker py <-> api ts)", () => {
  it("gates.py PUBLISH_ROLES equals studio.ts PUBLISH_ROLES", () => {
    const py = readFileSync(join(__dirname, "../../worker/pieces/gates.py"), "utf8");
    const ts = readFileSync(join(__dirname, "../src/routes/studio.ts"), "utf8");
    const pyMatch = py.match(/PUBLISH_ROLES\s*=\s*\{([^}]+)\}/);
    const tsMatch = ts.match(/PUBLISH_ROLES\s*=\s*new Set\(\[([^\]]+)\]\)/);
    expect(pyMatch, "PUBLISH_ROLES not found in gates.py").toBeTruthy();
    expect(tsMatch, "PUBLISH_ROLES not found in studio.ts").toBeTruthy();
    const extract = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(extract(pyMatch![1])).toEqual(extract(tsMatch![1]));
  });
});

describe("narration contract (golden <-> api ts <-> worker py)", () => {
  const golden = JSON.parse(
    readFileSync(join(__dirname, "../../worker/notes/narration_parity.json"), "utf8"),
  ) as {
    wire: { voices: string[]; overviewClipId: string; endpoint: string; queue: string;
            response: { noteId: string; voice: string; clips: { clipId: string; url: string }[] } };
  };

  it("the API sends on the queue the worker listens to", () => {
    const py = readFileSync(join(__dirname, "../../worker/notes/main.py"), "utf8");
    const consumed = py.match(/NARRATION_QUEUE\s*=\s*"([^"]+)"/);
    expect(consumed, "NARRATION_QUEUE not found in main.py").toBeTruthy();
    expect(NARRATION_QUEUE).toBe(consumed![1]);
    expect(NARRATION_QUEUE).toBe(golden.wire.queue);
    expect(py).toMatch(/QUEUE\s*=\s*"notes-jobs"/);
    expect(NARRATION_QUEUE).not.toBe("notes-jobs");
  });

  it("the route the app calls is the route this API registers", () => {
    const routes = readFileSync(join(__dirname, "../src/routes/notes.ts"), "utf8");
    const [path, query] = golden.wire.endpoint.split("?") as [string, string];
    expect(routes).toContain(`"${path.replace("{noteId}", ":id")}"`);
    expect(query).toBe("voice={voice}");
  });

  it("voices, the overview clip id and the blob layout are one set of names", () => {
    const py = readFileSync(join(__dirname, "../../worker/notes/narration.py"), "utf8");
    expect([...NARRATION_VOICES]).toEqual(golden.wire.voices);
    for (const voice of NARRATION_VOICES) expect(py).toContain(`"${voice}":`);
    expect(NARRATION_OVERVIEW_CLIP).toBe(golden.wire.overviewClipId);
    expect(py).toContain(`CLIP_EXT = "${NARRATION_CLIP_EXT}"`);
    const clip = golden.wire.response.clips[1]!;
    expect(clip.url).toContain(
      narrationClipPath(golden.wire.response.noteId, "jessica", clip.clipId),
    );
  });
});
