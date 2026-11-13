"use client";

import { useEffect, useState } from "react";
import type { MediaRef, VideoPlan } from "@/lib/plan";
import { prefs, sendShare, ShareError, uploadMedia, type SharedMediaInput } from "@/lib/share-client";

export type ShareRequest = { recipientName: string; phone: string; nonce: number };

type Sent = { name: string; phone: string };

/**
 * Texts the video to someone. The chatbot can pre-fill name and number, but
 * nothing is sent until the user taps Send. Photos are uploaded once per video;
 * later recipients reuse the same share (and see each other's reactions).
 */
export function SharePanel({
  plan,
  media,
  request,
  uploadMode,
}: {
  plan: VideoPlan;
  media: MediaRef[];
  request: ShareRequest | null;
  uploadMode: "blob" | "direct";
}) {
  const [open, setOpen] = useState(false);
  const [senderName, setSenderName] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [passcode, setPasscode] = useState("");
  const [needPasscode, setNeedPasscode] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [share, setShare] = useState<{ id: string; url: string } | null>(null);
  const [uploaded, setUploaded] = useState<SharedMediaInput[] | null>(null);
  const [sent, setSent] = useState<Sent[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setSenderName(prefs.senderName);
    setPasscode(prefs.passcode);
    setNeedPasscode(!prefs.passcode);
  }, []);

  // A new storyboard is a new video: start a fresh share.
  useEffect(() => {
    setShare(null);
    setUploaded(null);
    setSent([]);
  }, [plan, media]);

  useEffect(() => {
    if (!request) return;
    setRecipientName(request.recipientName);
    setPhone(request.phone);
    setError(null);
    setOpen(true);
  }, [request]);

  const submit = async () => {
    setError(null);
    if (!senderName.trim() || !recipientName.trim() || !phone.trim()) {
      setError("Fill in your name, their name and their phone number.");
      return;
    }
    if (!passcode.trim()) {
      setNeedPasscode(true);
      setError("Enter the sharing passcode.");
      return;
    }
    prefs.senderName = senderName.trim();
    try {
      let mediaForShare = uploaded;
      if (!share && !mediaForShare) {
        setBusy("Uploading…");
        mediaForShare = await uploadMedia(plan, media, passcode.trim(), uploadMode, (d, t) => setBusy(`Uploading ${d}/${t}…`));
        setUploaded(mediaForShare);
      }
      setBusy("Sending text…");
      const result = await sendShare(
        {
          senderName: senderName.trim(),
          recipientName: recipientName.trim(),
          phone: phone.trim(),
          note: note.trim() || undefined,
          ...(share ? { shareId: share.id } : { plan, media: mediaForShare! }),
        },
        passcode.trim(),
      );
      prefs.passcode = passcode.trim();
      setNeedPasscode(false);
      setShare({ id: result.shareId, url: result.url });
      setSent((s) => [...s, { name: recipientName.trim(), phone: phone.trim() }]);
      setRecipientName("");
      setPhone("");
      setNote("");
      setOpen(false);
    } catch (err) {
      if (err instanceof ShareError && err.status === 401) {
        prefs.passcode = "";
        setNeedPasscode(true);
      }
      setError(err instanceof Error ? err.message : "Sharing failed");
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the link is visible anyway */
    }
  };

  return (
    <div className="mt-3 border-t border-border pt-3 text-sm">
      {sent.length > 0 && share && (
        <div className="mb-3 rounded-xl bg-surface-2 p-3">
          <p>
            Texted to {sent.map((s) => s.name).join(", ")}. Their replies show up in the video as they arrive.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a href={share.url} target="_blank" rel="noreferrer" className="break-all text-accent underline">
              {share.url}
            </a>
            <button onClick={copyLink} className="rounded-lg border border-border px-2 py-1 text-xs">
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      )}

      {!open ? (
        <button onClick={() => setOpen(true)} className="rounded-lg border border-border px-3 py-1.5">
          {sent.length ? "Text it to someone else" : "Share by text message"}
        </button>
      ) : (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="font-medium">Text this video</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Their name" value={recipientName} onChange={setRecipientName} placeholder="Mom" autoComplete="off" />
            <Field label="Their phone" value={phone} onChange={setPhone} placeholder="+1 555 123 4567" type="tel" autoComplete="off" />
            <Field label="Your name (shown in the text)" value={senderName} onChange={setSenderName} placeholder="Shimon" autoComplete="given-name" />
            <Field label="Note (optional)" value={note} onChange={setNote} placeholder="Happy birthday!" />
            {needPasscode && (
              <Field label="Sharing passcode" value={passcode} onChange={setPasscode} type="password" autoComplete="off" />
            )}
          </div>
          <p className="text-xs text-muted">
            Sharing uploads the photos, clips and voice notes in this video so the link works on their phone. They can reply to the text to add a reaction to the video.
          </p>
          {error && <p className="text-danger">{error}</p>}
          <div className="flex gap-2">
            <button disabled={Boolean(busy)} className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-60">
              {busy ?? "Send text"}
            </button>
            <button type="button" disabled={Boolean(busy)} onClick={() => setOpen(false)} className="rounded-lg border border-border px-3 py-1.5">
              Cancel
            </button>
          </div>
        </form>
      )}
      {!open && error && <p className="mt-2 text-danger">{error}</p>}
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="grid gap-1">
      <span className="text-xs text-muted">{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
        className="rounded-lg border border-border bg-surface px-3 py-2 outline-none focus:border-accent"
      />
    </label>
  );
}
