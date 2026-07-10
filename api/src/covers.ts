import sharp from "sharp";

// Book covers render on an iOS bookshelf: portrait 3:4, retina-ready. Minimum tracks
// Apple Books' ~1400px shorter-edge guidance (600px would look soft at @3x). One
// normalized webp pair per book — the app never sees the original upload.
const MIN_W = 1200;
const MIN_H = 1600;
const ASPECT_MIN = 1.2; // h/w — accepts real-world book scans around 3:4
const ASPECT_MAX = 1.5;

export class CoverError extends Error {}

export interface ProcessedCover {
  cover: Buffer; // 1200×1600 webp
  thumb: Buffer; // 300×400 webp
}

export async function processCover(buf: Buffer): Promise<ProcessedCover> {
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    meta = await sharp(buf).metadata();
  } catch {
    throw new CoverError("The image couldn't be read. Use a JPEG, PNG, or WebP file.");
  }
  if (!meta.width || !meta.height) {
    throw new CoverError("The image couldn't be read. Use a JPEG, PNG, or WebP file.");
  }
  if (!["jpeg", "png", "webp"].includes(meta.format ?? "")) {
    throw new CoverError(`Unsupported format "${meta.format}". Use JPEG, PNG, or WebP.`);
  }
  // Phone photos carry EXIF orientation: metadata() reports pre-rotation dimensions,
  // so swap for the aspect/size checks and .rotate() before resizing — otherwise a
  // portrait photo is rejected as landscape or stored sideways.
  const sideways = (meta.orientation ?? 1) >= 5;
  const width = sideways ? meta.height : meta.width;
  const height = sideways ? meta.width : meta.height;
  const aspect = height / width;
  if (aspect < ASPECT_MIN || aspect > ASPECT_MAX) {
    throw new CoverError(
      `Image is ${width}×${height} — covers must be portrait, close to 3:4 (e.g. 1200×1600). Crop it and re-upload.`,
    );
  }
  if (width < MIN_W || height < MIN_H) {
    throw new CoverError(
      `Image is ${width}×${height}px — covers need at least ${MIN_W}×${MIN_H}px so they stay sharp on the app's bookshelf.`,
    );
  }
  try {
    const cover = await sharp(buf).rotate().resize(MIN_W, MIN_H, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
    const thumb = await sharp(buf).rotate().resize(300, 400, { fit: "cover" }).webp({ quality: 80 }).toBuffer();
    return { cover, thumb };
  } catch {
    throw new CoverError("The image couldn't be processed — it may be corrupt. Re-export it and try again.");
  }
}
