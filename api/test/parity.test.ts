import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PUBLISH_ROLES exists in two languages by necessity (worker stages artifacts, API
// filters them at publish). If they drift, a new artifact role is silently dropped
// from — or leaked into — the immutable bundle.
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
