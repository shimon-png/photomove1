import { z } from "zod";
import { guardSharing } from "@/lib/guard";
import { normalizePhone } from "@/lib/phone";
import { VideoPlanSchema } from "@/lib/plan";
import { addRecipient, createShare, getShareRecord, shareUrl, SharedMediaSchema } from "@/lib/shares";
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
  media: z.array(SharedMediaSchema).max(100).optional(),
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
    if (!b.plan || !b.media) return Response.json({ error: "Missing video" }, { status: 400 });
    const have = new Set(b.media.map((m) => m.id));
    const needed = [...b.plan.scenes.map((s) => s.media_id), ...(b.plan.voice_notes ?? []).map((v) => v.media_id)];
    if (needed.some((id) => !have.has(id)) || b.media.some((m) => !isSharedPhotoUrl(m.url))) {
      return Response.json({ error: "Some photos or videos weren't uploaded. Please try again." }, { status: 400 });
    }
    shareId = (await createShare({ senderName: b.senderName, plan: b.plan, media: b.media })).id;
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
