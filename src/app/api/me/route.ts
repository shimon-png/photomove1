import { sharingEnabled } from "@/lib/config";
import { getAccessToken } from "@/lib/google";

export async function GET() {
  const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const googleConnected = googleConfigured && Boolean(await getAccessToken());
  return Response.json({ googleConfigured, googleConnected, sharingEnabled: sharingEnabled() });
}
