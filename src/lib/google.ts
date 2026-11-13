import { readSession, writeSession, type GoogleSession } from "./session";

export const PICKER_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const PICKER_API = "https://photospicker.googleapis.com/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function redirectUri() {
  return `${env("APP_URL")}/api/auth/google/callback`;
}

export function authUrl(state: string) {
  const params = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: PICKER_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string };

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  return res.json();
}

export async function exchangeCode(code: string): Promise<GoogleSession> {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000 };
}

/**
 * Returns a valid access token, refreshing (and re-writing the cookie) if needed.
 * Must be called before a route starts streaming, since cookies can't be set after.
 */
export async function getAccessToken(): Promise<string | null> {
  const session = await readSession();
  if (!session) return null;
  if (session.expiresAt - 60_000 > Date.now()) return session.accessToken;
  if (!session.refreshToken) return null;
  try {
    const t = await tokenRequest({ refresh_token: session.refreshToken, grant_type: "refresh_token" });
    const next: GoogleSession = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? session.refreshToken,
      expiresAt: Date.now() + t.expires_in * 1000,
    };
    await writeSession(next);
    return next.accessToken;
  } catch {
    return null;
  }
}

export class GoogleApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function pickerFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PICKER_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GoogleApiError(res.status, `Google Photos Picker API ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

export type PickerSession = {
  id: string;
  pickerUri: string;
  mediaItemsSet?: boolean;
  expireTime?: string;
  pollingConfig?: { pollInterval?: string; timeoutIn?: string };
};

export type PickedMediaItem = {
  id: string;
  createTime?: string;
  type?: "PHOTO" | "VIDEO" | "TYPE_UNSPECIFIED";
  mediaFile: {
    baseUrl: string;
    mimeType?: string;
    filename?: string;
    mediaFileMetadata?: { width?: number; height?: number; cameraMake?: string; cameraModel?: string };
  };
};

export function createPickerSession(token: string, maxItems = 50) {
  return pickerFetch<PickerSession>(token, "/sessions", {
    method: "POST",
    body: JSON.stringify({ pickingConfig: { maxItemCount: String(maxItems) } }),
  });
}

export function getPickerSession(token: string, id: string) {
  return pickerFetch<PickerSession>(token, `/sessions/${encodeURIComponent(id)}`);
}

export async function listPickedItems(token: string, sessionId: string): Promise<PickedMediaItem[]> {
  const items: PickedMediaItem[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ sessionId, pageSize: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await pickerFetch<{ mediaItems?: PickedMediaItem[]; nextPageToken?: string }>(
      token,
      `/mediaItems?${q}`,
    );
    items.push(...(page.mediaItems ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

/** Only Google-hosted media URLs may be proxied (prevents SSRF via the image route). */
export function isGoogleMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && (u.hostname === "lh3.googleusercontent.com" || u.hostname.endsWith(".googleusercontent.com"));
  } catch {
    return false;
  }
}

/** Downloads a resized photo. Picker baseUrls require the OAuth bearer token. */
export async function fetchPhoto(token: string, baseUrl: string, maxSide: number) {
  if (!isGoogleMediaUrl(baseUrl)) throw new GoogleApiError(400, "Not a Google Photos media URL");
  const res = await fetch(`${baseUrl}=w${maxSide}-h${maxSide}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new GoogleApiError(res.status, `Photo download failed (${res.status})`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "image/jpeg" };
}
