import { guardSharing } from "@/lib/guard";
import { putPhoto } from "@/lib/store";

const MAX_BYTES = 4 * 1024 * 1024; // stays under Vercel's 4.5 MB request limit
const TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Uploads one (already downscaled) photo for a share. Body is the raw image bytes. */
export async function POST(req: Request) {
  const denied = await guardSharing(req, { bucket: "upload", perDay: 2000 });
  if (denied) return denied;
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  if (!TYPES.includes(type)) return Response.json({ error: "Unsupported image type" }, { status: 415 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return Response.json({ error: "Image too large" }, { status: 413 });
  const url = await putPhoto(bytes, type, "uploads");
  return Response.json({ url });
}
