/** Feature switches derived from environment variables. Server-only. */

export function appUrl(): string {
  const url = process.env.APP_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  return url.replace(/\/$/, "");
}

export function devMemoryStore(): boolean {
  return process.env.REELBOT_DEV_STORE === "memory";
}

export function storageConfigured(): boolean {
  if (devMemoryStore()) return true;
  const redis = Boolean(
    (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
      (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
  );
  return redis && Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export function smsConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      (process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_MESSAGING_SERVICE_SID),
  );
}

/** Sharing texts real people, so it needs every piece configured plus a passcode. */
export function sharingEnabled(): boolean {
  return Boolean(process.env.SHARE_PASSCODE) && storageConfigured() && smsConfigured() && Boolean(appUrl());
}

export function checkPasscode(given: string | null): boolean {
  const expected = process.env.SHARE_PASSCODE;
  if (!expected || !given) return false;
  // Constant-time-ish comparison.
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
