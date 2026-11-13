import { after } from "next/server";
import { appUrl } from "@/lib/config";
import { normalizePhone } from "@/lib/phone";
import { addReaction, placeReaction, shareForPhone, shareUrl } from "@/lib/shares";
import { kv } from "@/lib/store";
import { OPT_KEYWORDS, twiml, validTwilioSignature } from "@/lib/twilio";

export const maxDuration = 60;

const MAX_REACTION_CHARS = 280;
const MAX_REACTIONS_PER_SHARE = 50;

/**
 * Twilio "A message comes in" webhook. A reply from someone a video was shared
 * with becomes a reaction card; Claude places it in the video after we answer.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const params: Record<string, string> = {};
  form.forEach((v, k) => {
    if (typeof v === "string") params[k] = v;
  });
  if (!validTwilioSignature(`${appUrl()}/api/sms/inbound`, params, req.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }

  const from = normalizePhone(params.From ?? "");
  const body = (params.Body ?? "").trim();
  if (!from) return twiml();
  if (OPT_KEYWORDS.has(body.toUpperCase().replace(/[^A-Z]/g, ""))) return twiml(); // Twilio sends the compliance reply

  const found = await shareForPhone(from);
  if (!found) return twiml("Thanks for your message! There's no video linked to this number right now.");
  const { record, recipientName } = found;
  const url = shareUrl(record.id);

  if (!body) return twiml(`Thanks, ${recipientName}! Only text reactions can be added for now: ${url}`);

  const count = await kv().incr(`share:${record.id}:reaction-count`, 365 * 86400);
  if (count > MAX_REACTIONS_PER_SHARE) return twiml(`Thanks, ${recipientName}! This video already has lots of reactions.`);

  const text = body.length > MAX_REACTION_CHARS ? `${body.slice(0, MAX_REACTION_CHARS - 1)}…` : body;
  const reaction = await addReaction(record.id, recipientName, from, text);
  after(async () => {
    await placeReaction(record.id, reaction);
  });
  return twiml(`Thanks, ${recipientName}! Your reaction is being added to the video. Watch it here: ${url}`);
}
