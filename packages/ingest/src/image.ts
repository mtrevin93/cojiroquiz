import sharp from 'sharp';

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif']);
/** Browsers sometimes send no usable type (notably for HEIC); the sniffed format then decides. */
const UNKNOWN_MIME = new Set(['', 'application/octet-stream']);
const ALLOWED_FORMATS = new Set(['png', 'jpeg', 'webp', 'heif']);

export interface ProcessedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/** Returns an error message when the upload is not an acceptable image, else null. Reads headers only. */
export async function checkImage(bytes: Uint8Array, mimeType: string, maxBytes: number): Promise<string | null> {
  if (bytes.byteLength === 0) return 'The file is empty.';
  if (bytes.byteLength > maxBytes) return `The file is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).`;
  const mime = mimeType.toLowerCase().split(';')[0]!.trim();
  if (!ALLOWED_MIME.has(mime) && !UNKNOWN_MIME.has(mime)) return 'Only PNG, JPEG, WebP or HEIC images are accepted.';
  try {
    const meta = await sharp(bytes).metadata();
    if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) return 'Only PNG, JPEG, WebP or HEIC images are accepted.';
    if (!meta.width || !meta.height) return 'The image could not be read.';
  } catch {
    return 'The image could not be read.';
  }
  return null;
}

/**
 * Auto-rotate, drop all metadata (sharp strips EXIF/ICC unless asked to keep it),
 * cap the long edge and encode as webp. Throws when the image cannot be decoded.
 * The full screenshot is kept; the status bar is not cropped.
 */
export async function processScreenshot(bytes: Uint8Array, maxEdge: number): Promise<ProcessedImage> {
  const { data, info } = await sharp(bytes, { failOn: 'error' })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  return { bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

export async function imageSize(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  try {
    const meta = await sharp(bytes).metadata();
    return meta.width && meta.height ? { width: meta.width, height: meta.height } : null;
  } catch {
    return null;
  }
}

/** Crop a fractional box out of an image; null when the box is unusable or cropping fails. */
export async function cropBox(
  bytes: Uint8Array,
  box: { x: number; y: number; w: number; h: number },
): Promise<Uint8Array | null> {
  try {
    if (![box.x, box.y, box.w, box.h].every(Number.isFinite)) return null;
    const size = await imageSize(bytes);
    if (!size) return null;
    const left = Math.max(0, Math.min(size.width - 1, Math.round(box.x * size.width)));
    const top = Math.max(0, Math.min(size.height - 1, Math.round(box.y * size.height)));
    const width = Math.min(size.width - left, Math.round(box.w * size.width));
    const height = Math.min(size.height - top, Math.round(box.h * size.height));
    if (width < 8 || height < 8) return null;
    const out = await sharp(bytes).extract({ left, top, width, height }).webp({ quality: 85 }).toBuffer();
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch {
    return null;
  }
}
