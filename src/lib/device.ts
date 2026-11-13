import type { MediaKind, MediaRef } from "./plan";

/**
 * Device media (camera roll, files, voice recordings). Everything here runs in
 * the browser: the original files never leave the device. Claude only receives
 * small JPEG previews when it asks to see specific photos or videos.
 */

export const MAX_DEVICE_ITEMS = 100;
const PREFIX: Record<MediaKind, string> = { photo: "p", video: "v", audio: "a" };

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

export function kindOf(file: File): MediaKind | null {
  if (file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name)) return "photo";
  if (file.type.startsWith("video/") || /\.(mov|mp4|m4v|webm)$/i.test(file.name)) return "video";
  if (file.type.startsWith("audio/") || /\.(m4a|mp3|wav|aac|ogg|opus|caf)$/i.test(file.name)) return "audio";
  return null;
}

/**
 * Reads metadata for picked files and assigns ids that continue after
 * `existing` (p…, v…, a…), so adding a voice note keeps earlier ids stable.
 */
export async function loadDeviceMedia(
  files: File[],
  existing: MediaRef[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ media: MediaRef[]; skipped: string[] }> {
  const media: MediaRef[] = [];
  const skipped: string[] = [];
  const next: Record<MediaKind, number> = { photo: 0, video: 0, audio: 0 };
  for (const m of existing) {
    const n = Number(m.id.slice(1));
    if (m.id.startsWith(PREFIX[m.kind]) && n > next[m.kind]) next[m.kind] = n;
  }
  const list = files.slice(0, Math.max(0, MAX_DEVICE_ITEMS - existing.length));
  // Sequential on purpose: decoding many full-size camera files at once can exhaust phone memory.
  for (const [i, file] of list.entries()) {
    const kind = kindOf(file);
    try {
      if (!kind) throw new Error("unsupported");
      const meta = kind === "photo" ? await photoMeta(file) : kind === "video" ? await videoMeta(file) : await audioMeta(file);
      media.push({ id: `${PREFIX[kind]}${++next[kind]}`, kind, filename: file.name.slice(0, 200), file, ...meta });
    } catch {
      skipped.push(file.name); // e.g. HEIC on a desktop browser, or a codec this browser can't play
    }
    onProgress?.(i + 1, list.length);
  }
  return { media, skipped };
}

async function photoMeta(file: File) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const taken = await readExifDate(file).catch(() => null);
  const meta = { createTime: localIso(taken ?? new Date(file.lastModified)), width: bmp.width, height: bmp.height };
  bmp.close();
  return meta;
}

/** Loads a video element for a file or URL and waits for its metadata. */
export function loadVideoElement(src: string, timeoutMs = 15000): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    const timer = setTimeout(() => reject(new Error("video load timeout")), timeoutMs);
    v.onloadedmetadata = () => {
      clearTimeout(timer);
      resolve(v);
    };
    v.onerror = () => {
      clearTimeout(timer);
      reject(new Error("video can't be played in this browser"));
    };
    v.src = src;
  });
}

/** Seeks a video and resolves once the frame at `t` is ready to draw. */
export function seekTo(v: HTMLVideoElement, t: number, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const target = Math.min(Math.max(t, 0), Math.max(0, (v.duration || 0) - 0.05));
    if (Math.abs(v.currentTime - target) < 0.01 && v.readyState >= 2) return resolve();
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener("seeked", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    v.addEventListener("seeked", done);
    v.currentTime = target;
  });
}

function frameToCanvas(v: HTMLVideoElement, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(v.videoWidth * scale));
  c.height = Math.max(1, Math.round(v.videoHeight * scale));
  c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
  return c;
}

async function videoMeta(file: File) {
  const url = URL.createObjectURL(file);
  try {
    const v = await loadVideoElement(url);
    const duration = v.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("no duration");
    await seekTo(v, Math.min(1, duration / 2));
    const thumbBlob = await new Promise<Blob | null>((r) => frameToCanvas(v, 200).toBlob(r, "image/jpeg", 0.7));
    const created = await readMp4CreationTime(file).catch(() => null);
    const width = v.videoWidth || undefined;
    const height = v.videoHeight || undefined;
    v.removeAttribute("src");
    v.load();
    return {
      createTime: localIso(created ?? new Date(file.lastModified)),
      width,
      height,
      duration_s: Math.round(duration * 10) / 10,
      thumb: thumbBlob ? URL.createObjectURL(thumbBlob) : undefined,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function audioMeta(file: File) {
  let duration = await new Promise<number>((resolve) => {
    const a = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const finish = (d: number) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    a.preload = "metadata";
    a.onloadedmetadata = () => finish(a.duration);
    a.onerror = () => finish(NaN);
    a.src = url;
  });
  if (!Number.isFinite(duration) || duration <= 0) {
    // Recorded WebM often reports Infinity; decode to measure it.
    const ctx = new AudioContext();
    try {
      duration = (await ctx.decodeAudioData(await file.arrayBuffer())).duration;
    } finally {
      void ctx.close();
    }
  }
  return { createTime: localIso(new Date(file.lastModified)), duration_s: Math.round(duration * 10) / 10 };
}

/**
 * Preview JPEG for Claude (base64, no data: prefix). Videos become a strip of
 * three frames (start, middle, end) so Claude can judge the whole clip.
 */
export async function mediaPreviewBase64(m: MediaRef, maxSide = 384): Promise<string> {
  let canvas: HTMLCanvasElement;
  if (m.kind === "video" && m.file) {
    const url = URL.createObjectURL(m.file);
    try {
      const v = await loadVideoElement(url);
      const d = v.duration;
      const frames: HTMLCanvasElement[] = [];
      for (const t of [Math.min(0.5, d * 0.1), d * 0.5, Math.max(0, d - 0.5)]) {
        await seekTo(v, t);
        frames.push(frameToCanvas(v, 256));
      }
      canvas = document.createElement("canvas");
      canvas.width = frames.reduce((w, f) => w + f.width, 0) + 8 * (frames.length - 1);
      canvas.height = Math.max(...frames.map((f) => f.height));
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      let x = 0;
      for (const f of frames) {
        ctx.drawImage(f, x, 0);
        x += f.width + 8;
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  } else if (m.file) {
    const bmp = await decodeScaled(m.file, maxSide);
    canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
  } else if (m.baseUrl) {
    const res = await fetch(`/api/photos/image?u=${encodeURIComponent(m.baseUrl)}&s=${maxSide}`);
    if (!res.ok) throw new Error("preview failed");
    const bmp = await createImageBitmap(await res.blob());
    canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
  } else {
    throw new Error("nothing to preview");
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.8),
  );
  return blobToBase64(blob);
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Reads creation_time from an MP4/MOV 'mvhd' box (seconds since 1904, UTC). */
async function readMp4CreationTime(file: File): Promise<Date | null> {
  let offset = 0;
  for (let guard = 0; guard < 64 && offset + 8 <= file.size; guard++) {
    const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    let headerLen = 8;
    if (size === 1) {
      size = Number(head.getBigUint64(8));
      headerLen = 16;
    } else if (size === 0) size = file.size - offset;
    if (size < headerLen) return null;
    if (type === "moov") {
      const moov = new DataView(await file.slice(offset + headerLen, offset + Math.min(size, 8 * 1024 * 1024)).arrayBuffer());
      for (let i = 0; i + 24 < moov.byteLength; i++) {
        // 'mvhd' = 6d 76 68 64
        if (moov.getUint32(i) !== 0x6d766864) continue;
        const version = moov.getUint8(i + 4);
        const secs = version === 1 ? Number(moov.getBigUint64(i + 8)) : moov.getUint32(i + 8);
        if (!secs) return null;
        const d = new Date(Date.UTC(1904, 0, 1) + secs * 1000);
        return d.getFullYear() > 1971 ? d : null;
      }
      return null;
    }
    offset += size;
  }
  return null;
}

/** Local wall-clock time, e.g. 2024-07-04T18:30:00 (EXIF dates carry no time zone). */
function localIso(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
