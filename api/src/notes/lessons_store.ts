import {
  BlobSASPermissions,
  SASProtocol,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { blobService, blobProps } from "../blob";

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

export function createBlobLessonStore(connectionString: string): LessonStore {
  const { credential, service } = blobService(connectionString);
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
    audioProps(path) {
      return blobProps(container, path);
    },
    async deleteAudio(path) {
      await container.getBlockBlobClient(path).deleteIfExists();
    },
  };
}
