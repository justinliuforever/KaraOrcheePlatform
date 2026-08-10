import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  RestError,
  type ContainerClient,
} from "@azure/storage-blob";

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

export function blobService(connectionString: string): {
  accountName: string;
  credential: StorageSharedKeyCredential;
  service: BlobServiceClient;
} {
  const { accountName, accountKey } = parseConnectionString(connectionString);
  const credential = new StorageSharedKeyCredential(accountName, accountKey);
  const service = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    credential,
  );
  return { accountName, credential, service };
}

export async function blobProps(
  container: ContainerClient,
  path: string,
): Promise<{ bytes: number; etag: string | null } | null> {
  try {
    const props = await container.getBlockBlobClient(path).getProperties();
    return { bytes: props.contentLength ?? 0, etag: props.etag ?? null };
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) return null;
    throw err;
  }
}

export async function deleteBlobsUnder(container: ContainerClient, prefix: string): Promise<void> {
  // A prefix that is not a folder would sweep siblings — an empty one, the container.
  if (!prefix.endsWith("/")) throw new Error("deletePrefix requires a trailing slash");
  for await (const blob of container.listBlobsFlat({ prefix })) {
    await container.getBlockBlobClient(blob.name).deleteIfExists();
  }
}
