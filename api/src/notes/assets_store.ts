import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  RestError,
} from "@azure/storage-blob";

const CONTAINER = "notes-assets"; // durable: transcripts survive the 90d lesson-audio delete

// Read-only access to the durable notes-assets container. Today the sole caller is
// the break-glass transcript viewer in the Notes admin console. Connection-string /
// shared-key auth only (project rule: never credential-based — avoids token expiry).
export interface NotesAssetsStore {
  // Parsed transcript JSON, or null when the blob is absent.
  readTranscript(path: string): Promise<unknown | null>;
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

export function createBlobNotesAssetsStore(connectionString: string): NotesAssetsStore {
  const { accountName, accountKey } = parseConnectionString(connectionString);
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const service = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential,
  );
  const container = service.getContainerClient(CONTAINER);

  return {
    async readTranscript(path) {
      try {
        const buf = await container.getBlockBlobClient(path).downloadToBuffer();
        return JSON.parse(buf.toString("utf8"));
      } catch (err) {
        if (err instanceof RestError && err.statusCode === 404) return null;
        throw err;
      }
    },
  };
}
