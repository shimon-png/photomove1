import { cookies } from "next/headers";
import { authUrl } from "@/lib/google";
import { randomState } from "@/lib/session";

/** Starts Google OAuth. A random state cookie protects the callback against CSRF. */
export async function GET() {
  const state = randomState();
  const store = await cookies();
  store.set("reelbot_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return Response.redirect(authUrl(state), 302);
}
