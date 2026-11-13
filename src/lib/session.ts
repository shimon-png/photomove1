import { EncryptJWT, jwtDecrypt, base64url } from "jose";
import { createHash } from "crypto";
import { cookies } from "next/headers";

/**
 * Google tokens live in an encrypted (JWE), httpOnly cookie so the app is
 * stateless and runs on serverless hosts without a database.
 */
const COOKIE = "reelbot_session";
const MAX_AGE = 60 * 60 * 24 * 30;

export type GoogleSession = {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt: number;
};

function key(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters");
  }
  // Derive a 256-bit key for A256GCM.
  return createHash("sha256").update(secret).digest();
}

export async function writeSession(session: GoogleSession) {
  const token = await new EncryptJWT({ ...session })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .encrypt(key());
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function readSession(): Promise<GoogleSession | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtDecrypt(token, key());
    if (typeof payload.accessToken !== "string" || typeof payload.expiresAt !== "number") return null;
    return {
      accessToken: payload.accessToken,
      refreshToken: typeof payload.refreshToken === "string" ? payload.refreshToken : undefined,
      expiresAt: payload.expiresAt,
    };
  } catch {
    return null;
  }
}

export async function clearSession() {
  const store = await cookies();
  store.delete(COOKIE);
}

export function randomState(): string {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(24)));
}
