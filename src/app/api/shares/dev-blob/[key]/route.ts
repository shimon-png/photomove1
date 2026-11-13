import { devBlob } from "@/lib/store";

/** Serves photos from the in-memory dev store (REELBOT_DEV_STORE=memory only). */
export async function GET(_req: Request, ctx: RouteContext<"/api/shares/dev-blob/[key]">) {
  const { key } = await ctx.params;
  const blob = devBlob(key);
  if (!blob) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(blob.bytes), { headers: { "Content-Type": blob.type, "Access-Control-Allow-Origin": "*" } });
}
