// Enough head for every APP segment a camera JPEG carries ahead of SOS; a file that needs more is rejected, not trusted.
export const SCAN_HEAD_BYTES = 64 * 1024;

export type JpegVerdict =
  | "ok"
  | "not_jpeg"
  | "exif"
  | "metadata"
  | "head_truncated"
  | "unreadable";


function startsWith(buf: Buffer, ident: string): boolean {
  return buf.length >= ident.length && buf.toString("latin1", 0, ident.length) === ident;
}

// The same two segments ScoreScanPageEncoder keeps — one allow-list, asserted on both sides of the wire.
function appVerdict(marker: number, payload: Buffer): "ok" | "exif" | "metadata" {
  if (marker === 0xe1) return "exif";
  if (marker === 0xe0) return startsWith(payload, "JFIF\0") ? "ok" : "metadata";
  if (marker === 0xe2) return startsWith(payload, "ICC_PROFILE\0") ? "ok" : "metadata";
  return "metadata";
}

export function jpegHeadVerdict(head: Buffer | null): JpegVerdict {
  if (!head || head.length < 3) return "not_jpeg";
  if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return "not_jpeg";
  const ranOut: JpegVerdict = head.length >= SCAN_HEAD_BYTES ? "head_truncated" : "unreadable";
  let p = 2;
  while (p + 1 < head.length) {
    if (head[p] !== 0xff) return "unreadable";
    while (head[p + 1] === 0xff && p + 2 < head.length) p++;
    const marker = head[p + 1]!;
    if (marker === 0x00) return "unreadable";
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return "ok";
    if (p + 3 >= head.length) return ranOut;
    const len = head.readUInt16BE(p + 2);
    if (len < 2) return "unreadable";
    const end = p + 2 + len;
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      if (end > head.length) return ranOut;
      const verdict = marker === 0xfe ? "metadata" : appVerdict(marker, head.subarray(p + 4, end));
      if (verdict !== "ok") return verdict;
    }
    p = end;
  }
  return ranOut;
}
