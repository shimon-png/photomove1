import type { NextRequest } from "next/server";
import { isSharedPhotoUrl } from "@/lib/store";

/** Same-origin fallback for shared photos, in case the blob host's CORS headers block canvas use. */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("u");
  if (!url || !isSharedPhotoUrl(url)) return new Response("Bad url", { status: 400 });
  const res = await fetch(url);
  if (!res.ok) return new Response("Not found", { status: 404 });
  return new Response(res.body, {
    headers: { "Content-Type": res.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "public, max-age=86400" },
  });
}
