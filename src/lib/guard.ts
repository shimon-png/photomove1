import { checkPasscode, sharingEnabled } from "./config";
import { kv } from "./store";

/** Shared checks for the owner-only sharing endpoints. Returns an error Response, or null when allowed. */
export async function guardSharing(req: Request, limit: { bucket: string; perDay: number }): Promise<Response | null> {
  if (!sharingEnabled()) return Response.json({ error: "Sharing is not set up on this server." }, { status: 503 });
  if (!checkPasscode(req.headers.get("x-share-passcode"))) {
    return Response.json({ error: "Wrong sharing passcode." }, { status: 401 });
  }
  const day = new Date().toISOString().slice(0, 10);
  const count = await kv().incr(`rate:${limit.bucket}:${day}`, 2 * 86400);
  if (count > limit.perDay) return Response.json({ error: "Daily sharing limit reached. Try again tomorrow." }, { status: 429 });
  return null;
}
