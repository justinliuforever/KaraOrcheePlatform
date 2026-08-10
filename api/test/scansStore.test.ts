import { describe, it, expect, beforeEach, vi } from "vitest";
import { RestError } from "@azure/storage-blob";
import { createBlobScanStore, ScanChangedError } from "../src/notes/scans_store";

interface FakeBlob {
  url: string;
  properties: { contentLength: number; etag: string };
  propertiesError: unknown;
  copyError: unknown;
  copies: { source: string; options: { sourceConditions?: { ifMatch?: string } } }[];
  headers: { blobContentType?: string; blobContentDisposition?: string }[];
  getProperties(): Promise<{ contentLength: number; etag: string }>;
  syncCopyFromURL(
    source: string,
    options: { sourceConditions?: { ifMatch?: string } },
  ): Promise<void>;
  setHTTPHeaders(headers: {
    blobContentType?: string;
    blobContentDisposition?: string;
  }): Promise<void>;
}

const azure = vi.hoisted(() => {
  const blobs = new Map<string, FakeBlob>();
  const blob = (containerName: string, path: string): FakeBlob => {
    const key = `${containerName}/${path}`;
    const existing = blobs.get(key);
    if (existing) return existing;
    const made: FakeBlob = {
      url: `https://stfake.blob.core.windows.net/${key}`,
      properties: { contentLength: 1024, etag: '"0x8DEFAULT"' },
      propertiesError: null,
      copyError: null,
      copies: [],
      headers: [],
      async getProperties() {
        if (made.propertiesError) throw made.propertiesError;
        return made.properties;
      },
      async syncCopyFromURL(source, options) {
        made.copies.push({ source, options });
        if (made.copyError) throw made.copyError;
      },
      async setHTTPHeaders(headers) {
        made.headers.push(headers);
      },
    };
    blobs.set(key, made);
    return made;
  };
  return { blobs, blob };
});

vi.mock("@azure/storage-blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/storage-blob")>();
  class FakeBlobServiceClient {
    getContainerClient(containerName: string) {
      return { getBlockBlobClient: (path: string) => azure.blob(containerName, path) };
    }
  }
  return { ...actual, BlobServiceClient: FakeBlobServiceClient };
});

const CONNECTION =
  "DefaultEndpointsProtocol=https;AccountName=stfake;AccountKey=" +
  Buffer.from("not-a-real-key").toString("base64") +
  ";EndpointSuffix=core.windows.net";

const STAGED = "incoming/owner-1/scan-1/1.jpg";
const DURABLE = "owner-1/scan-1/1.jpg";

function staged(): FakeBlob {
  return azure.blob("score-scans", STAGED);
}

function durable(): FakeBlob {
  return azure.blob("score-scans", DURABLE);
}

beforeEach(() => {
  azure.blobs.clear();
});

describe("the score-scan blob store", () => {
  it("pins a promoted page to image/jpeg and inline", async () => {
    const store = createBlobScanStore(CONNECTION);

    await store.promote(STAGED, DURABLE);

    expect(durable().headers).toEqual([
      { blobContentType: "image/jpeg", blobContentDisposition: "inline" },
    ]);
  });

  it("reports the ETag beside the byte count and copies under it", async () => {
    const store = createBlobScanStore(CONNECTION);
    staged().properties = { contentLength: 4096, etag: '"0x8DMEASURED"' };

    const props = await store.pageProps(STAGED);
    expect(props).toEqual({ bytes: 4096, etag: '"0x8DMEASURED"' });

    await store.promote(STAGED, DURABLE, { ifMatch: props!.etag });

    const copies = durable().copies;
    expect(copies).toHaveLength(1);
    expect(copies[0]!.options.sourceConditions).toEqual({ ifMatch: '"0x8DMEASURED"' });
    expect(new URL(copies[0]!.source).pathname).toBe(`/score-scans/${STAGED}`);
  });

  it("refuses to promote a page rewritten since the gate measured it", async () => {
    const store = createBlobScanStore(CONNECTION);
    durable().copyError = new RestError("source condition not met", { statusCode: 412 });

    await expect(
      store.promote(STAGED, DURABLE, { ifMatch: '"0x8DMEASURED"' }),
    ).rejects.toBeInstanceOf(ScanChangedError);

    expect(durable().headers).toEqual([]);
  });

  it("answers null for a page that was never uploaded", async () => {
    const store = createBlobScanStore(CONNECTION);
    staged().propertiesError = new RestError("not found", { statusCode: 404 });

    expect(await store.pageProps(STAGED)).toBeNull();
  });
});
