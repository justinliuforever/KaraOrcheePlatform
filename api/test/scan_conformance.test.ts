import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCAN_HEAD_BYTES, jpegHeadVerdict, type JpegVerdict } from "../src/notes/jpeg";

const CORPUS = fileURLToPath(new URL("./fixtures/scan_conformance.json", import.meta.url));
const APP_CORPUS = fileURLToPath(
  new URL("../../../KaraOrcheeAMT/Tests/Fixtures/scan_conformance.json", import.meta.url),
);

type Case = {
  name: string;
  what: string;
  table: string | null;
  iosKeepsApp: string[];
  serverRawVerdict: JpegVerdict;
  serverStrippedVerdict: JpegVerdict | null;
  agreement: string;
  divergence?: string;
  raw: string;
  iosStripped: string | null;
};

function loadCorpus(): Case[] {
  let text: string;
  try {
    text = readFileSync(CORPUS, "utf8");
  } catch {
    throw new Error(
      `scan_conformance.json not found at ${CORPUS} — the server half of the corpus lives in this repo ` +
        `so CI can run it; regenerate it from the app's copy rather than editing it here.`,
    );
  }
  return JSON.parse(text).cases as Case[];
}

const CASES = loadCorpus();

describe("the corpus the two halves share", () => {
  it("is byte-identical to the app's copy wherever both repos are checked out", () => {
    let app: string;
    try {
      app = readFileSync(APP_CORPUS, "utf8");
    } catch {
      return;
    }
    expect(app).toBe(readFileSync(CORPUS, "utf8"));
  });
});

function verdictOfPageAsTheCommitGateReadsIt(base64: string): JpegVerdict {
  return jpegHeadVerdict(Buffer.from(base64, "base64").subarray(0, SCAN_HEAD_BYTES));
}

const verdictOf = verdictOfPageAsTheCommitGateReadsIt;

function derivedAgreement(c: Case): string {
  if (c.iosStripped === null) return c.serverRawVerdict === "ok" ? "ios_refuses_server_admits" : "agree_refuse";
  return verdictOf(c.iosStripped) === "ok" ? "agree" : "ios_admits_server_refuses";
}

describe("the cross-side JPEG conformance corpus", () => {
  it("is the app repo's own file, holds every photograph, and is not a stub", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(60);
    expect(CASES.filter((c) => c.name.startsWith("photo_"))).toHaveLength(9);
    expect(CASES.filter((c) => c.name.startsWith("encoded_"))).toHaveLength(9);
    expect(CASES.filter((c) => c.table === "allow-list").length).toBeGreaterThanOrEqual(20);
    expect(CASES.filter((c) => c.iosStripped !== null).length).toBeGreaterThan(40);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
  });

  it("still reads every case's raw bytes the way the commit gate reads a page", () => {
    for (const c of CASES) {
      expect(verdictOf(c.raw), `${c.name} — ${c.what}`).toBe(c.serverRawVerdict);
    }
  });

  it("admits every byte the iOS encoder produced, so no page the phone sends earns a permanent 415", () => {
    const refused = CASES.filter((c) => c.iosStripped !== null && verdictOf(c.iosStripped) !== "ok");
    expect(refused.map((c) => `${c.name}: ${verdictOf(c.iosStripped!)}`)).toEqual([
      "icc_multichunk_over_head: head_truncated",
    ]);
  });

  it("agrees segment by segment with the encoder's allow-list", () => {
    for (const c of CASES.filter((x) => x.table === "allow-list")) {
      expect(c.serverRawVerdict === "ok", `${c.name} — ${c.what}`).toBe(c.iosKeepsApp.length > 0);
    }
  });

  it("keeps every recorded agreement equal to the one the two implementations actually produce", () => {
    for (const c of CASES) {
      expect(derivedAgreement(c), `${c.name} — ${c.what}`).toBe(c.agreement);
    }
    expect(CASES.filter((c) => c.agreement === "ios_admits_server_refuses").map((c) => c.name)).toEqual([
      "icc_multichunk_over_head",
    ]);
    expect(CASES.filter((c) => c.agreement === "ios_refuses_server_admits").map((c) => c.name)).toEqual([
      "soi_eoi_only",
      "fill_bytes_before_sos",
      "fill_bytes_before_app0",
      "soi_repeated_in_stream",
    ]);
  });

  it("takes every one of the nine photographs, and every page the encoder made of them", () => {
    for (const c of CASES.filter((x) => x.name.startsWith("photo_") || x.name.startsWith("encoded_"))) {
      expect(verdictOf(c.raw), c.name).toBe("ok");
      expect(c.iosStripped, c.name).not.toBeNull();
      expect(verdictOf(c.iosStripped!), c.name).toBe("ok");
    }
  });

  it("is handed nothing by the encoder but a JFIF block and an ICC profile", () => {
    const kept = new Set(CASES.filter((c) => c.name.startsWith("encoded_")).flatMap((c) => c.iosKeepsApp));
    expect([...kept].sort()).toEqual(["e0", "e2"]);
  });

  it("refuses a multi-chunk ICC profile the encoder keeps, which is a 415 no retake can clear", () => {
    const over = CASES.find((x) => x.name === "icc_multichunk_over_head")!;
    expect(Buffer.from(over.iosStripped!, "base64").length).toBeGreaterThan(SCAN_HEAD_BYTES);
    expect(verdictOf(over.iosStripped!)).toBe("head_truncated");
    const under = CASES.find((x) => x.name === "icc_multichunk_under_head")!;
    expect(verdictOf(under.iosStripped!)).toBe("ok");
  });

  it("admits four byte patterns the encoder refuses outright, none of which it can be handed today", () => {
    for (const name of ["soi_eoi_only", "fill_bytes_before_sos", "fill_bytes_before_app0", "soi_repeated_in_stream"]) {
      const c = CASES.find((x) => x.name === name)!;
      expect(c.iosStripped, name).toBeNull();
      expect(verdictOf(c.raw), name).toBe("ok");
    }
  });

  it("lets metadata placed after the scan header through, on both sides alike", () => {
    for (const name of ["com_after_sos", "app1_exif_after_sos"]) {
      const c = CASES.find((x) => x.name === name)!;
      const stripped = Buffer.from(c.iosStripped!, "base64");
      expect(verdictOf(c.iosStripped!), name).toBe("ok");
      expect(stripped.includes(Buffer.from([0xff, name === "com_after_sos" ? 0xfe : 0xe1])), name).toBe(true);
    }
  });
});
