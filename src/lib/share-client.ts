import { decodeScaled } from "./device";
import type { MediaRef, VideoPlan } from "./plan";
import { imageUrl } from "./render";

/** Browser-side sharing helpers: upload the video's photos, then ask the server to text the link. */

const PASSCODE_KEY = "reelbot_share_passcode";
const SENDER_KEY = "reelbot_sender_name";

export const prefs = {
  get passcode() {
    return read(PASSCODE_KEY);
  },
  set passcode(v: string) {
    write(PASSCODE_KEY, v);
  },
  get senderName() {
    return read(SENDER_KEY);
  },
  set senderName(v: string) {
    write(SENDER_KEY, v);
  },
};

function read(key: string) {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function write(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* private mode: just don't remember */
  }
}

export class ShareError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

async function toJpeg(photo: MediaRef): Promise<Blob> {
  let bmp: ImageBitmap;
  if (photo.file) bmp = await decodeScaled(photo.file, 1920);
  else {
    const res = await fetch(imageUrl(photo, 1920));
    if (!res.ok) throw new ShareError("A Google photo couldn't be loaded. Pick the photos again and retry.");
    bmp = await createImageBitmap(await res.blob());
  }
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new ShareError("Couldn't prepare a photo"))), "image/jpeg", 0.85),
  );
}

async function postJson<T>(url: string, body: unknown, passcode: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-share-passcode": passcode },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ShareError(data.error ?? `Request failed (${res.status})`, res.status);
  return data;
}

async function postRaw(body: Blob, type: string, passcode: string): Promise<string> {
  const res = await fetch("/api/shares/photo", {
    method: "POST",
    headers: { "Content-Type": type, "x-share-passcode": passcode },
    body,
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !data.url) throw new ShareError(data.error ?? `Upload failed (${res.status})`, res.status);
  return data.url;
}

const MAX_SHARE_BYTES = 200 * 1024 * 1024;

/** A file's media type, guessed from its name when the browser leaves it blank (common for .mov/.m4a). */
function typeOf(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    mov: "video/quicktime", mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm",
    m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", ogg: "audio/ogg", caf: "audio/x-caf",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

export type SharedMediaInput = { id: string; kind: MediaRef["kind"]; url: string; createTime?: string; duration_s?: number };

/**
 * Uploads the media a plan uses (once per item), three at a time. Photos are
 * downscaled JPEGs through our API; videos and voice notes go straight to
 * Vercel Blob with a client token ("blob"), or through our API in local dev
 * ("direct").
 */
export async function uploadMedia(
  plan: VideoPlan,
  media: MediaRef[],
  passcode: string,
  mode: "blob" | "direct",
  onProgress: (done: number, total: number) => void,
): Promise<SharedMediaInput[]> {
  const byId = new Map(media.map((m) => [m.id, m]));
  const ids = [...new Set([...plan.scenes.map((s) => s.media_id), ...(plan.voice_notes ?? []).map((v) => v.media_id)])];
  const out: SharedMediaInput[] = [];
  const queue = [...ids];
  let done = 0;
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const m = byId.get(id);
      if (!m) throw new ShareError(`${id} is missing from the selection`);
      let url: string;
      if (m.kind === "photo") {
        url = await postRaw(await toJpeg(m), "image/jpeg", passcode);
      } else {
        if (!m.file) throw new ShareError(`${id} can't be shared`);
        if (m.file.size > MAX_SHARE_BYTES) throw new ShareError(`${m.filename ?? id} is too large to share (max 200 MB).`);
        const type = typeOf(m.file);
        if (mode === "direct") url = await postRaw(m.file, type, passcode);
        else {
          const { upload } = await import("@vercel/blob/client");
          const ext = m.file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "") || "bin";
          const blob = await upload(`shares/media/${id}.${ext}`, m.file, {
            access: "public",
            handleUploadUrl: "/api/shares/upload-token",
            headers: { "x-share-passcode": passcode },
            contentType: type,
            multipart: m.file.size > 20 * 1024 * 1024,
          }).catch((err: unknown) => {
            throw new ShareError(err instanceof Error ? err.message : "Upload failed");
          });
          url = blob.url;
        }
      }
      out.push({ id, kind: m.kind, url, createTime: m.createTime, duration_s: m.duration_s });
      onProgress(++done, ids.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

export type ShareResult = { shareId: string; url: string };

export function sendShare(
  body: {
    senderName: string;
    recipientName: string;
    phone: string;
    note?: string;
    shareId?: string;
    plan?: VideoPlan;
    media?: SharedMediaInput[];
  },
  passcode: string,
) {
  return postJson<ShareResult>("/api/shares", body, passcode);
}
