import {
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
  RestError,
} from "@azure/storage-blob";
import { blobService, blobProps, deleteBlobsUnder } from "../blob";
import { ASSET_READ_SAS_MINUTES } from "./assets_store";

const CONTAINER = "score-scans"; // bicep lifecycle: incoming sweep @1d, version purge @7d, cool @30d, delete disabled
const UPLOAD_SAS_HOURS = 2;
const INCOMING = "incoming/";

export class ScanChangedError extends Error {
  constructor() {
    super("scan_page_changed");
    this.name = "ScanChangedError";
  }
}

export interface ScanStore {
  incomingPath(ownerId: string, scanId: string, n: number): string;
  incomingPrefix(ownerId: string, scanId: string): string;
  blobPath(ownerId: string, scanId: string, n: number): string;
  blobPrefix(ownerId: string, scanId: string): string;
  // Single-blob, write-only, HTTPS-only; refuses any path outside incoming/, so nothing a client holds can address the durable prefix.
  uploadUrl(path: string): string;
  // The etag is what pins a later promote to these exact bytes; the upload SAS outlives the gate.
  pageProps(path: string): Promise<{ bytes: number; etag: string | null } | null>;
  readHead(path: string, bytes: number): Promise<Buffer | null>;
  // Server-side copy into the durable prefix — no bytes on the wire; without ifMatch the size gate is bypassable.
  promote(from: string, to: string, opts?: { ifMatch?: string | null }): Promise<void>;
  // Single-blob, read-only, HTTPS-only, minutes-long. Never container-scoped.
  readUrl(path: string): string;
  deletePrefix(prefix: string): Promise<void>;
}

export function createBlobScanStore(connectionString: string): ScanStore {
  const { credential, service } = blobService(connectionString);
  const container = service.getContainerClient(CONTAINER);

  const incomingPrefix = (ownerId: string, scanId: string): string =>
    `${INCOMING}${ownerId}/${scanId}/`;
  const blobPrefix = (ownerId: string, scanId: string): string => `${ownerId}/${scanId}/`;

  const readUrl = (path: string): string => {
    const sas = generateBlobSASQueryParameters(
      {
        containerName: CONTAINER,
        blobName: path,
        permissions: BlobSASPermissions.parse("r"),
        protocol: SASProtocol.Https,
        expiresOn: new Date(Date.now() + ASSET_READ_SAS_MINUTES * 60 * 1000),
        contentType: "image/jpeg",
        contentDisposition: "inline",
      },
      credential,
    ).toString();
    return `${container.getBlockBlobClient(path).url}?${sas}`;
  };

  return {
    incomingPrefix,
    blobPrefix,
    incomingPath(ownerId, scanId, n) {
      return `${incomingPrefix(ownerId, scanId)}${n}.jpg`;
    },
    blobPath(ownerId, scanId, n) {
      return `${blobPrefix(ownerId, scanId)}${n}.jpg`;
    },
    uploadUrl(path) {
      if (!path.startsWith(INCOMING)) throw new Error("uploadUrl is scoped to incoming/");
      const sas = generateBlobSASQueryParameters(
        {
          containerName: CONTAINER,
          blobName: path,
          permissions: BlobSASPermissions.parse("cw"),
          protocol: SASProtocol.Https,
          expiresOn: new Date(Date.now() + UPLOAD_SAS_HOURS * 60 * 60 * 1000),
        },
        credential,
      ).toString();
      return `${container.getBlockBlobClient(path).url}?${sas}`;
    },
    pageProps(path) {
      return blobProps(container, path);
    },
    async readHead(path, bytes) {
      try {
        const res = await container.getBlockBlobClient(path).download(0, bytes);
        const parts: Uint8Array[] = [];
        for await (const chunk of res.readableStreamBody!) parts.push(chunk as Uint8Array);
        return Buffer.concat(parts);
      } catch (err) {
        if (err instanceof RestError && err.statusCode === 404) return null;
        // A zero-byte blob answers a range request with 416; its leading bytes are none.
        if (err instanceof RestError && err.statusCode === 416) return Buffer.alloc(0);
        throw err;
      }
    },
    async promote(from, to, opts) {
      const dest = container.getBlockBlobClient(to);
      const ifMatch = opts?.ifMatch;
      try {
        await dest.syncCopyFromURL(
          readUrl(from),
          ifMatch ? { sourceConditions: { ifMatch } } : {},
        );
      } catch (err) {
        if (err instanceof RestError && err.statusCode === 412) throw new ScanChangedError();
        throw err;
      }
      // The copy carries the type the client uploaded with — this pin is what keeps a scan from ever being servable as text/html.
      await dest.setHTTPHeaders({
        blobContentType: "image/jpeg",
        blobContentDisposition: "inline",
      });
    },
    readUrl,
    deletePrefix(prefix) {
      return deleteBlobsUnder(container, prefix);
    },
  };
}
