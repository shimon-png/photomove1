import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { exchangeCode } from "@/lib/google";
import { writeSession } from "@/lib/session";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const store = await cookies();
  const expected = store.get("reelbot_oauth_state")?.value;
  store.delete("reelbot_oauth_state");
  const home = new URL("/", process.env.APP_URL ?? req.nextUrl.origin);

  if (!code || !state || !expected || state !== expected) {
    home.searchParams.set("error", "oauth");
    return Response.redirect(home, 302);
  }
  try {
    await writeSession(await exchangeCode(code));
  } catch {
    home.searchParams.set("error", "oauth");
  }
  return Response.redirect(home, 302);
}
