import type { NextRequest } from "next/server";
import { fetchPhoto, getAccessToken, GoogleApiError, isGoogleMediaUrl } from "@/lib/google";

/**
 * Same-origin proxy for picked photos. Picker base URLs need the OAuth token,
 * and same-origin images keep the canvas untainted so it can be recorded.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("u");
  const size = Math.min(Math.max(Number(req.nextUrl.searchParams.get("s")) || 1920, 64), 4096);
  if (!url || !isGoogleMediaUrl(url)) return new Response("Bad url", { status: 400 });
  const token = await getAccessToken();
  if (!token) return new Response("Not connected", { status: 401 });
  try {
    const { bytes, contentType } = await fetchPhoto(token, url, size);
    return new Response(bytes, {
      headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=3000" },
    });
  } catch (err) {
    return new Response("Fetch failed", { status: err instanceof GoogleApiError && err.status === 403 ? 403 : 502 });
  }
}
