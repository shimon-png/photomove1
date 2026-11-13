import type { NextRequest } from "next/server";
import { createPickerSession, getAccessToken, getPickerSession, GoogleApiError, listPickedItems } from "@/lib/google";
import { toPhotoRefs } from "@/lib/photos";

/** Starts a Google Photos picker session; the browser opens the returned pickerUri. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { maxItems?: unknown };
  const maxItems = Math.min(Math.max(Number(body.maxItems) || 30, 1), 100);
  const token = await getAccessToken();
  if (!token) return Response.json({ error: "Not connected" }, { status: 401 });
  try {
    const session = await createPickerSession(token, maxItems);
    return Response.json({ sessionId: session.id, pickerUri: session.pickerUri });
  } catch {
    return Response.json({ error: "Could not start Google Photos picker" }, { status: 502 });
  }
}

/**
 * Polled by the browser while the picker is open. Once the user is done,
 * returns the picked photos (short id + base URL for the image proxy).
 */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id || id.length > 200) return Response.json({ error: "Missing id" }, { status: 400 });
  const token = await getAccessToken();
  if (!token) return Response.json({ error: "Not connected" }, { status: 401 });
  try {
    const session = await getPickerSession(token, id);
    if (!session.mediaItemsSet) return Response.json({ ready: false, pollInterval: session.pollingConfig?.pollInterval });
    const photos = toPhotoRefs(await listPickedItems(token, id));
    return Response.json({ ready: true, photos });
  } catch (err) {
    const status = err instanceof GoogleApiError ? err.status : 500;
    return Response.json({ error: "Could not read picker session" }, { status: status === 404 ? 404 : 502 });
  }
}
