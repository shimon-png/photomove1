import { getPublicShare } from "@/lib/shares";

/** Public view of a shared video (no phone numbers). Polled by the share page for new reactions. */
export async function GET(_req: Request, ctx: RouteContext<"/api/shares/[id]">) {
  const { id } = await ctx.params;
  const share = await getPublicShare(id);
  if (!share) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(share, { headers: { "Cache-Control": "no-store" } });
}
