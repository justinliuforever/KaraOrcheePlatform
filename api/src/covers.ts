import sharp from "sharp";

// Book covers render on an iOS bookshelf: portrait 3:4. Acceptance floor 900×1200
// (visually clear covers were being rejected under the old 1200×1600 floor); storage
// output stays a normalized 1200×1600 webp pair (mild upscale for smaller inputs) so
// the app always receives one consistent size.
const MIN_W = 900;
const MIN_H = 1200;
const OUT_W = 1200;
const OUT_H = 1600;
const ASPECT_MIN = 1.2; // h/w — accepts real-world book scans around 3:4
const ASPECT_MAX = 1.5;

export class CoverError extends Error {}

export interface ProcessedCover {
  cover: Buffer; // 1200×1600 webp
  thumb: Buffer; // 300×400 webp
}

// Composer portraits render as small square avatars in the app: any aspect is
// accepted (center-crop), normalized to one consistent 512×512 webp.
const PORTRAIT_MIN = 256;
const PORTRAIT_OUT = 512;

export async function processPortrait(buf: Buffer): Promise<Buffer> {
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
  const sideways = (meta.orientation ?? 1) >= 5;
  const width = sideways ? meta.height : meta.width;
  const height = sideways ? meta.width : meta.height;
  if (Math.min(width, height) < PORTRAIT_MIN) {
    throw new CoverError(
      `Image is ${width}×${height}px — portraits need at least ${PORTRAIT_MIN}×${PORTRAIT_MIN}px on the short side to stay sharp.`,
    );
  }
  try {
    return await sharp(buf)
      .rotate()
      .resize(PORTRAIT_OUT, PORTRAIT_OUT, { fit: "cover" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    throw new CoverError("The image couldn't be processed — it may be corrupt. Re-export it and try again.");
  }
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
      `Image is ${width}×${height} — covers must be portrait, close to 3:4 (e.g. 900×1200). Crop it and re-upload.`,
    );
  }
  if (width < MIN_W || height < MIN_H) {
    throw new CoverError(
      `Image is ${width}×${height}px — covers need at least ${MIN_W}×${MIN_H}px so they stay sharp on the app's bookshelf.`,
    );
  }
  try {
    const cover = await sharp(buf).rotate().resize(OUT_W, OUT_H, { fit: "cover" }).webp({ quality: 82 }).toBuffer();
    const thumb = await sharp(buf).rotate().resize(300, 400, { fit: "cover" }).webp({ quality: 80 }).toBuffer();
    return { cover, thumb };
  } catch {
    throw new CoverError("The image couldn't be processed — it may be corrupt. Re-export it and try again.");
  }
}
