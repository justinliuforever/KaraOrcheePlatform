import {
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
  RestError,
} from "@azure/storage-blob";
import { blobService, deleteBlobsUnder } from "../blob";

const CONTAINER = "notes-assets"; // transcripts expire at 90d; narration lives with its note

// Long enough to prefetch a note's whole narration set on a slow connection, short
// enough that a leaked URL is worthless by the time it travels.
export const ASSET_READ_SAS_MINUTES = 15;

// Access to the notes-assets container: the break-glass transcript viewer reads,
// the client plays narration through short-lived read URLs, and note/account
// deletion purges. Connection-string / shared-key auth only (project rule: never
// credential-based — avoids token expiry).
export interface NotesAssetsStore {
  // Parsed JSON derivative (transcript, model output), or null when the blob is absent.
  readJson(path: string): Promise<unknown | null>;
  // Single-blob, read-only, HTTPS-only, minutes-long. Never container-scoped.
  readUrl(path: string): string;
  // Server-side copy inside the container — the whole point is that no audio crosses
  // the wire and no vendor character is spent to duplicate a note.
  copyAsset(from: string, to: string): Promise<void>;
  // Idempotent: deleting an absent blob is a no-op.
  deleteAsset(path: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export function createBlobNotesAssetsStore(connectionString: string): NotesAssetsStore {
  const { credential, service } = blobService(connectionString);
  const container = service.getContainerClient(CONTAINER);

  const readUrl = (path: string): string => {
    const sas = generateBlobSASQueryParameters(
      {
        containerName: CONTAINER,
        blobName: path,
        permissions: BlobSASPermissions.parse("r"),
        protocol: SASProtocol.Https,
        expiresOn: new Date(Date.now() + ASSET_READ_SAS_MINUTES * 60 * 1000),
      },
      credential,
    ).toString();
    return `${container.getBlockBlobClient(path).url}?${sas}`;
  };

  return {
    async readJson(path) {
      try {
        const buf = await container.getBlockBlobClient(path).downloadToBuffer();
        return JSON.parse(buf.toString("utf8"));
      } catch (err) {
        if (err instanceof RestError && err.statusCode === 404) return null;
        throw err;
      }
    },
    readUrl,
    async copyAsset(from, to) {
      await container.getBlockBlobClient(to).syncCopyFromURL(readUrl(from));
    },
    async deleteAsset(path) {
      await container.getBlockBlobClient(path).deleteIfExists();
    },
    deletePrefix(prefix) {
      return deleteBlobsUnder(container, prefix);
    },
  };
}
