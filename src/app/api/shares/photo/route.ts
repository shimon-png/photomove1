import { devMemoryStore } from "@/lib/config";
import { guardSharing } from "@/lib/guard";
import { putPhoto } from "@/lib/store";

const MAX_BYTES = 4 * 1024 * 1024; // stays under Vercel's 4.5 MB request limit
const TYPES = ["image/jpeg", "image/png", "image/webp"];
// The in-memory dev store has no client-upload endpoint, so it takes videos and voice notes here too.
const DEV_TYPES = /^(video|audio)\//;

/** Uploads one (already downscaled) photo for a share. Body is the raw image bytes. */
export async function POST(req: Request) {
  const denied = await guardSharing(req, { bucket: "upload", perDay: 2000 });
  if (denied) return denied;
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  const dev = devMemoryStore() && DEV_TYPES.test(type);
  if (!TYPES.includes(type) && !dev) return Response.json({ error: "Unsupported file type" }, { status: 415 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0 || (!dev && bytes.byteLength > MAX_BYTES)) return Response.json({ error: "File too large" }, { status: 413 });
  const url = await putPhoto(bytes, type, "uploads");
  return Response.json({ url });
}
