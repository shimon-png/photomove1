import { decodeScaled } from "./device";
import type { PhotoRef, VideoPlan } from "./plan";
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

async function toJpeg(photo: PhotoRef): Promise<Blob> {
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

/** Uploads the photos a plan uses (once per photo), three at a time. */
export async function uploadPhotos(
  plan: VideoPlan,
  photos: PhotoRef[],
  passcode: string,
  onProgress: (done: number, total: number) => void,
): Promise<{ id: string; url: string; createTime?: string }[]> {
  const byId = new Map(photos.map((p) => [p.id, p]));
  const ids = [...new Set(plan.scenes.map((s) => s.photo_id))];
  const out: { id: string; url: string; createTime?: string }[] = [];
  const queue = [...ids];
  let done = 0;
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const photo = byId.get(id);
      if (!photo) throw new ShareError(`Photo ${id} is missing from the selection`);
      const jpeg = await toJpeg(photo);
      const res = await fetch("/api/shares/photo", {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", "x-share-passcode": passcode },
        body: jpeg,
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new ShareError(data.error ?? `Upload failed (${res.status})`, res.status);
      out.push({ id, url: data.url, createTime: photo.createTime });
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
    photos?: { id: string; url: string; createTime?: string }[];
  },
  passcode: string,
) {
  return postJson<ShareResult>("/api/shares", body, passcode);
}
