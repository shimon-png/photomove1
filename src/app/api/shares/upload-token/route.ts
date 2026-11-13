import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { guardSharing } from "@/lib/guard";

/** Allowed direct-to-Blob uploads for shared videos and voice notes. */
const TYPES = [
  "video/mp4", "video/quicktime", "video/webm", "video/x-m4v",
  "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/mpeg", "audio/wav", "audio/x-wav",
  "audio/webm", "audio/ogg", "audio/opus", "audio/x-caf",
];
const MAX_BYTES = 200 * 1024 * 1024;

/**
 * Issues short-lived client tokens so the browser can upload large files
 * straight to Vercel Blob (bypassing the 4.5 MB function body limit).
 * Requires the sharing passcode, sent as a header by @vercel/blob/client.
 */
export async function POST(req: Request) {
  const denied = await guardSharing(req, { bucket: "upload", perDay: 2000 });
  if (denied) return denied;
  const body = (await req.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: TYPES,
        maximumSizeInBytes: MAX_BYTES,
        addRandomSuffix: true,
      }),
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Upload not allowed" }, { status: 400 });
  }
}
