import { z } from "zod";
import { guardSharing } from "@/lib/guard";
import { normalizePhone } from "@/lib/phone";
import { VideoPlanSchema } from "@/lib/plan";
import { addRecipient, createShare, getShareRecord, shareUrl, SharedPhotoSchema } from "@/lib/shares";
import { isSharedPhotoUrl } from "@/lib/store";
import { sendSms, SmsError } from "@/lib/twilio";

const Body = z.object({
  senderName: z.string().trim().min(1).max(40),
  recipientName: z.string().trim().min(1).max(40),
  phone: z.string().max(30),
  note: z.string().trim().max(160).optional(),
  // Either an existing share (texting one more person) or a new video to share.
  shareId: z.string().max(40).optional(),
  plan: VideoPlanSchema.optional(),
  photos: z.array(SharedPhotoSchema).max(100).optional(),
});

/** Creates a share (or reuses one) and texts the link to a recipient. */
export async function POST(req: Request) {
  const denied = await guardSharing(req, { bucket: "sms", perDay: 50 });
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Please check the name and phone number." }, { status: 400 });
  const b = parsed.data;
  const phone = normalizePhone(b.phone);
  if (!phone) return Response.json({ error: "Enter the phone number with its country code, e.g. +1 555 123 4567." }, { status: 400 });

  let shareId = b.shareId;
  if (shareId) {
    if (!(await getShareRecord(shareId))) return Response.json({ error: "That shared video no longer exists." }, { status: 404 });
  } else {
    if (!b.plan || !b.photos) return Response.json({ error: "Missing video" }, { status: 400 });
    const have = new Set(b.photos.map((p) => p.id));
    if (b.plan.scenes.some((s) => !have.has(s.photo_id)) || b.photos.some((p) => !isSharedPhotoUrl(p.url))) {
      return Response.json({ error: "Some photos weren't uploaded. Please try again." }, { status: 400 });
    }
    shareId = (await createShare({ senderName: b.senderName, plan: b.plan, photos: b.photos })).id;
  }

  const url = shareUrl(shareId);
  const text =
    `Hi ${b.recipientName}! ${b.senderName} made you a video: ${url}` +
    (b.note ? `\n\n"${b.note}"` : "") +
    `\n\nReply to this text with your reaction and it'll be added to the video. Reply STOP to opt out.`;
  try {
    await sendSms(phone, text);
  } catch (err) {
    const message = err instanceof SmsError ? `The text couldn't be sent: ${err.message}` : "The text couldn't be sent.";
    return Response.json({ error: message, shareId, url }, { status: 502 });
  }
  await addRecipient(shareId, b.recipientName, phone);
  return Response.json({ shareId, url });
}
