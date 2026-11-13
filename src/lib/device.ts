import type { PhotoRef } from "./plan";

/**
 * Camera-roll / device photos. Everything here runs in the browser: the
 * original files never leave the device. Claude only receives small JPEG
 * previews when it asks to see specific photos.
 */

export const MAX_DEVICE_PHOTOS = 100;

/** Decodes a photo, scaled so its longest side is at most maxSide. Honors EXIF orientation. */
export async function decodeScaled(file: Blob, maxSide: number): Promise<ImageBitmap> {
  const full = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = maxSide / Math.max(full.width, full.height);
  if (scale >= 1) return full;
  const scaled = await createImageBitmap(full, {
    resizeWidth: Math.round(full.width * scale),
    resizeHeight: Math.round(full.height * scale),
    resizeQuality: "high",
  });
  full.close();
  return scaled;
}

export async function loadDevicePhotos(
  files: File[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ photos: PhotoRef[]; skipped: string[] }> {
  const photos: PhotoRef[] = [];
  const skipped: string[] = [];
  const list = files.filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name)).slice(0, MAX_DEVICE_PHOTOS);
  // Sequential on purpose: decoding many full-size camera photos at once can exhaust phone memory.
  for (const [i, file] of list.entries()) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const taken = await readExifDate(file).catch(() => null);
      photos.push({
        id: `p${photos.length + 1}`,
        filename: file.name.slice(0, 200),
        createTime: localIso(taken ?? new Date(file.lastModified)),
        width: bmp.width,
        height: bmp.height,
        file,
      });
      bmp.close();
    } catch {
      skipped.push(file.name); // e.g. HEIC on a desktop browser that can't decode it
    }
    onProgress?.(i + 1, list.length);
  }
  return { photos, skipped };
}

/** Local wall-clock time, e.g. 2024-07-04T18:30:00 (EXIF dates carry no time zone). */
function localIso(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Small JPEG preview for Claude, base64 without the data: prefix. */
export async function previewBase64(file: File, maxSide = 384): Promise<string> {
  const bmp = await decodeScaled(file, maxSide);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.8),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Reads EXIF DateTimeOriginal (or DateTime) from a JPEG, if present. */
async function readExifDate(file: File): Promise<Date | null> {
  const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
  if (buf.byteLength < 4 || buf.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 4 < buf.byteLength) {
    const marker = buf.getUint16(off);
    const len = buf.getUint16(off + 2);
    if (marker === 0xffe1 && buf.getUint32(off + 4) === 0x45786966) return parseTiff(buf, off + 10);
    if ((marker & 0xff00) !== 0xff00) return null;
    off += 2 + len;
  }
  return null;
}

function parseTiff(buf: DataView, tiff: number): Date | null {
  const little = buf.getUint16(tiff) === 0x4949;
  const u16 = (o: number) => buf.getUint16(o, little);
  const u32 = (o: number) => buf.getUint32(o, little);
  const ascii = (o: number, n: number) => {
    let s = "";
    for (let i = 0; i < n && o + i < buf.byteLength; i++) {
      const c = buf.getUint8(o + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const readIfd = (ifd: number) => {
    const tags = new Map<number, number>();
    if (ifd + 2 > buf.byteLength) return tags;
    const count = u16(ifd);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > buf.byteLength) break;
      tags.set(u16(e), e);
    }
    return tags;
  };
  const dateAt = (entry: number | undefined) => {
    if (entry === undefined) return null;
    const s = ascii(tiff + u32(entry + 8), 19); // "YYYY:MM:DD HH:MM:SS"
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
  };
  const ifd0 = readIfd(tiff + u32(tiff + 4));
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr !== undefined) {
    const exif = readIfd(tiff + u32(exifPtr + 8));
    const d = dateAt(exif.get(0x9003));
    if (d) return d;
  }
  return dateAt(ifd0.get(0x0132));
}
