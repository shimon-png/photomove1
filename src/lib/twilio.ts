import { createHmac, timingSafeEqual } from "crypto";

/** Minimal Twilio Programmable Messaging client (REST + webhook signature check). */

const API_BASE = process.env.TWILIO_API_BASE ?? "https://api.twilio.com";

export async function sendSms(to: string, body: string): Promise<{ sid: string }> {
  const sid = process.env.TWILIO_ACCOUNT_SID!;
  const token = process.env.TWILIO_AUTH_TOKEN!;
  const params = new URLSearchParams({ To: to, Body: body });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) params.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SERVICE_SID);
  else params.set("From", process.env.TWILIO_FROM_NUMBER!);

  const res = await fetch(`${API_BASE}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
  });
  const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
  if (!res.ok || !data.sid) {
    throw new SmsError(data.message ?? `Twilio error ${res.status}`, data.code);
  }
  return { sid: data.sid };
}

export class SmsError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
  }
}

/**
 * Validates X-Twilio-Signature: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)).
 * `url` must be exactly the webhook URL configured in Twilio.
 */
export function validTwilioSignature(url: string, params: Record<string, string>, signature: string | null): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = createHmac("sha1", token).update(data, "utf8").digest();
  const given = Buffer.from(signature, "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** TwiML response that replies with one SMS (or nothing). */
export function twiml(message?: string): Response {
  const body = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
  return new Response(body, { headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

function escapeXml(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/** Carrier opt-out / help keywords; Twilio handles the compliance replies, so these are not reactions. */
export const OPT_KEYWORDS = new Set([
  "STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT",
  "START", "UNSTOP", "YES", "HELP", "INFO",
]);
