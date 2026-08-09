import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
  RestError,
} from "@azure/storage-blob";
import { ASSET_READ_SAS_MINUTES } from "./assets_store";

const CONTAINER = "score-scans"; // bicep lifecycle: incoming sweep @1d, version purge @7d, cool @30d, delete disabled
const UPLOAD_SAS_HOURS = 2;
const INCOMING = "incoming/";

export interface ScanStore {
  incomingPath(ownerId: string, scanId: string, n: number): string;
  incomingPrefix(ownerId: string, scanId: string): string;
  blobPath(ownerId: string, scanId: string, n: number): string;
  blobPrefix(ownerId: string, scanId: string): string;
  // Single-blob, write-only, HTTPS-only; refuses any path outside incoming/, so nothing a client holds can address the durable prefix.
  uploadUrl(path: string): string;
  pageProps(path: string): Promise<{ bytes: number } | null>;
  readHead(path: string, bytes: number): Promise<Buffer | null>;
  // Server-side copy into the durable prefix — no bytes on the wire.
  promote(from: string, to: string): Promise<void>;
  // Single-blob, read-only, HTTPS-only, minutes-long. Never container-scoped.
  readUrl(path: string): string;
  deletePrefix(prefix: string): Promise<void>;
}

function parseConnectionString(cs: string): { accountName: string; accountKey: string } {
  const parts = Object.fromEntries(
    cs.split(";").map((kv) => {
      const idx = kv.indexOf("=");
      return [kv.slice(0, idx), kv.slice(idx + 1)];
    }),
  );
  const accountName = parts["AccountName"];
  const accountKey = parts["AccountKey"];
  if (!accountName || !accountKey) {
    throw new Error("STORAGE_CONNECTION_STRING missing AccountName/AccountKey");
  }
  return { accountName, accountKey };
}

export function createBlobScanStore(connectionString: string): ScanStore {
  const { accountName, accountKey } = parseConnectionString(connectionString);
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const service = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential,
  );
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

  const deletePrefix = async (prefix: string): Promise<void> => {
    // A prefix that is not a folder would sweep siblings — an empty one, the container.
    if (!prefix.endsWith("/")) throw new Error("deletePrefix requires a trailing slash");
    for await (const blob of container.listBlobsFlat({ prefix })) {
      await container.getBlockBlobClient(blob.name).deleteIfExists();
    }
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
    async pageProps(path) {
      try {
        const props = await container.getBlockBlobClient(path).getProperties();
        return { bytes: props.contentLength ?? 0 };
      } catch (err) {
        if (err instanceof RestError && err.statusCode === 404) return null;
        throw err;
      }
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
    async promote(from, to) {
      const dest = container.getBlockBlobClient(to);
      await dest.syncCopyFromURL(readUrl(from));
      // The copy carries the type the client uploaded with — this pin is what keeps a scan from ever being servable as text/html.
      await dest.setHTTPHeaders({
        blobContentType: "image/jpeg",
        blobContentDisposition: "inline",
      });
    },
    readUrl,
    deletePrefix,
  };
}
