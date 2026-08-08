import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
  RestError,
} from "@azure/storage-blob";

const CONTAINER = "lesson-audio";  // bicep lifecycle: cool @30d, DELETE @90d
const UPLOAD_SAS_HOURS = 2;

// SAS is single-blob, write-only — the server always chooses the blob path, never the client.
export interface LessonStore {
  uploadUrl(path: string): string;
  blobPath(teacherId: string, lessonId: string): string;
  // null when the client never finished the upload.
  audioProps(path: string): Promise<{ bytes: number } | null>;
  deleteAudio(path: string): Promise<void>;
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

export function createBlobLessonStore(connectionString: string): LessonStore {
  const { accountName, accountKey } = parseConnectionString(connectionString);
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const service = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential,
  );
  const container = service.getContainerClient(CONTAINER);

  return {
    blobPath(teacherId, lessonId) {
      return `${teacherId}/${lessonId}.m4a`;
    },
    uploadUrl(path) {
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
    async audioProps(path) {
      try {
        const props = await container.getBlockBlobClient(path).getProperties();
        return { bytes: props.contentLength ?? 0 };
      } catch (err) {
        if (err instanceof RestError && err.statusCode === 404) return null;
        throw err;
      }
    },
    async deleteAudio(path) {
      await container.getBlockBlobClient(path).deleteIfExists();
    },
  };
}
