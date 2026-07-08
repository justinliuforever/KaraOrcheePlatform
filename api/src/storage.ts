import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
  RestError,
} from "@azure/storage-blob";

const CONTAINER = "piece-bundles";
const SOURCES_CONTAINER = "piece-sources";
const CATALOG_BLOB = "catalog.json";
const SAS_MINUTES = 60;

export class CatalogNotFoundError extends Error {
  constructor() {
    super("catalog_not_published");
    this.name = "CatalogNotFoundError";
  }
}

export interface CatalogStore {
  readCatalog(): Promise<unknown>;
  signReadUrl(blobUrl: string): string;
}

// Write-side operations for Pieces Studio: source intake, staging→immutable
// copies at publish, and catalog.json regeneration. Kept separate from
// CatalogStore so read paths never gain write capability by accident.
export interface StudioStore {
  uploadSource(path: string, data: Buffer, contentType?: string): Promise<void>;
  copySource(fromPath: string, toPath: string): Promise<void>;
  copyWithinBundles(fromPath: string, toPath: string): Promise<void>;
  putBundleJson(path: string, body: unknown): Promise<void>;
  putBundleBlob(path: string, data: Buffer, contentType: string): Promise<void>;
  bundleUrl(path: string): string;
  sourceUrl(path: string): string;
  listSources(prefix: string): Promise<{ path: string; bytes: number }[]>;
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

export function createBlobCatalogStore(connectionString: string): CatalogStore {
  const { accountName, accountKey } = parseConnectionString(connectionString);
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const service = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential,
  );

  return {
    async readCatalog() {
      const blob = service.getContainerClient(CONTAINER).getBlockBlobClient(CATALOG_BLOB);
      try {
        const buf = await blob.downloadToBuffer();
        return JSON.parse(buf.toString("utf8"));
      } catch (err) {
        if (err instanceof RestError && err.statusCode === 404) {
          throw new CatalogNotFoundError();
        }
        throw err;
      }
    },
    signReadUrl(blobUrl) {
      const u = new URL(blobUrl);
      const segments = u.pathname.replace(/^\/+/, "").split("/");
      const containerName = segments.shift() ?? CONTAINER;
      const blobName = decodeURIComponent(segments.join("/"));
      const sas = generateBlobSASQueryParameters(
        {
          containerName,
          blobName,
          permissions: BlobSASPermissions.parse("r"),
          protocol: SASProtocol.Https,
          expiresOn: new Date(Date.now() + SAS_MINUTES * 60 * 1000),
        },
        credential,
      ).toString();
      return `${blobUrl}?${sas}`;
    },
  };
}

export function createBlobStudioStore(connectionString: string): StudioStore {
  const { accountName, accountKey } = parseConnectionString(connectionString);
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const service = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential,
  );
  const bundles = service.getContainerClient(CONTAINER);
  const sources = service.getContainerClient(SOURCES_CONTAINER);

  function signedCopyUrl(containerName: string, blobName: string, srcUrl: string): string {
    const sas = generateBlobSASQueryParameters(
      {
        containerName,
        blobName,
        permissions: BlobSASPermissions.parse("r"),
        protocol: SASProtocol.Https,
        expiresOn: new Date(Date.now() + 10 * 60 * 1000),
      },
      credential,
    ).toString();
    return `${srcUrl}?${sas}`;
  }

  return {
    async uploadSource(path, data, contentType) {
      await sources.getBlockBlobClient(path).uploadData(data, {
        blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
      });
    },
    async copySource(fromPath, toPath) {
      const src = sources.getBlockBlobClient(fromPath);
      await sources
        .getBlockBlobClient(toPath)
        .syncCopyFromURL(signedCopyUrl(SOURCES_CONTAINER, fromPath, src.url));
    },
    async copyWithinBundles(fromPath, toPath) {
      const src = bundles.getBlockBlobClient(fromPath);
      await bundles
        .getBlockBlobClient(toPath)
        .syncCopyFromURL(signedCopyUrl(CONTAINER, fromPath, src.url));
    },
    async putBundleJson(path, body) {
      const data = Buffer.from(JSON.stringify(body, null, 2));
      await bundles.getBlockBlobClient(path).uploadData(data, {
        blobHTTPHeaders: { blobContentType: "application/json" },
      });
    },
    async putBundleBlob(path, data, contentType) {
      await bundles.getBlockBlobClient(path).uploadData(data, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
    },
    bundleUrl(path) {
      return `https://${accountName}.blob.core.windows.net/${CONTAINER}/${path}`;
    },
    sourceUrl(path) {
      return `https://${accountName}.blob.core.windows.net/${SOURCES_CONTAINER}/${path}`;
    },
    async listSources(prefix) {
      const out: { path: string; bytes: number }[] = [];
      for await (const blob of sources.listBlobsFlat({ prefix })) {
        out.push({ path: blob.name, bytes: blob.properties.contentLength ?? 0 });
      }
      return out;
    },
  };
}
