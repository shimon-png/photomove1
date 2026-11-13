"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadDevicePhotos, MAX_DEVICE_PHOTOS, previewBase64 } from "@/lib/device";
import type { ChatEvent, ClientToolCall, PhotoRef, Selection, VideoPlan } from "@/lib/plan";
import { imageUrl } from "@/lib/render";
import { VideoPanel } from "./VideoPanel";

/** Raw API message as returned by the server; replayed unchanged on every request. */
type ContentBlock = { type: string; text?: string; content?: unknown };
type ApiMessage = { role: "user" | "assistant"; content: string | ContentBlock[] };
type Bubble = { role: "user" | "assistant"; text: string };
type Me = { googleConfigured: boolean; googleConnected: boolean };
type GooglePick = { sessionId: string; pickerUri: string; status: "waiting" | "expired" };

const MAX_PREVIEWS = 36; // matches the server's per-conversation cap
const STASH_KEY = "reelbot_pending_chat";

const SUGGESTIONS = [
  "Make a 30-second highlight reel of my trip",
  "Create a vertical video for Instagram Reels",
  "Make a slow, sentimental birthday montage with captions",
];

function toBubbles(messages: ApiMessage[]): Bubble[] {
  const out: Bubble[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, text: m.content });
      continue;
    }
    const text = m.content
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) out.push({ role: m.role, text });
  }
  return out;
}

function countPreviews(messages: ApiMessage[]) {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && Array.isArray(b.content)) n += (b.content as ContentBlock[]).filter((c) => c.type === "image").length;
    }
  }
  return n;
}

export function Reelbot() {
  const [me, setMe] = useState<Me | null>(null);
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [live, setLive] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [chooser, setChooser] = useState<{ maxItems: number } | null>(null);
  const [googlePick, setGooglePick] = useState<GooglePick | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [photos, setPhotos] = useState<PhotoRef[]>([]);
  const [plan, setPlan] = useState<VideoPlan | null>(null);
  const messagesRef = useRef<ApiMessage[]>([]);
  const selectionRef = useRef<Selection>({ source: "none" });
  const photosRef = useRef<PhotoRef[]>([]);
  const busyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const setHistory = (h: ApiMessage[]) => {
    messagesRef.current = h;
    setMessages(h);
  };

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((d: Me) => setMe(d))
      .catch(() => setMe({ googleConfigured: false, googleConnected: false }));
    if (new URLSearchParams(window.location.search).get("error") === "oauth") {
      setError("Google sign-in didn't complete. Please try again, or choose photos from your device.");
    }
    // Restore a conversation stashed before the Google sign-in redirect.
    try {
      const stashed = sessionStorage.getItem(STASH_KEY);
      if (stashed) {
        sessionStorage.removeItem(STASH_KEY);
        const { messages: m, maxItems } = JSON.parse(stashed) as { messages: ApiMessage[]; maxItems: number };
        setHistory(m);
        setChooser({ maxItems });
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, live, status, chooser, googlePick, plan, preparing]);

  /** One request to /api/chat. Returns the tool calls the browser must run, if any. */
  const chatTurn = useCallback(async (userMsg: ApiMessage) => {
    const history = [...messagesRef.current, userMsg];
    setHistory(history);
    setLive("");
    let pending: { calls: ClientToolCall[]; results: unknown[] } | null = null;

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, selection: selectionRef.current }),
    });
    if (res.status === 401) {
      setMe((m) => (m ? { ...m, googleConnected: false } : m));
      throw new Error("Your Google session expired. Reconnect Google Photos or choose photos from your device.");
    }
    if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line) as ChatEvent;
        switch (ev.type) {
          case "text":
            setStatus(null);
            setLive((s) => s + ev.text);
            break;
          case "status":
            setLive((s) => (s ? s + "\n\n" : s));
            setStatus(ev.text);
            break;
          case "choose_photos":
            setChooser({ maxItems: ev.maxItems });
            break;
          case "video_plan":
            setPlan(ev.plan);
            break;
          case "client_tools":
            pending = { calls: ev.calls, results: ev.results };
            break;
          case "messages":
            setHistory([...messagesRef.current, ...(ev.messages as ApiMessage[])]);
            break;
          case "error":
            setError(ev.message);
            break;
        }
      }
    }
    setLive("");
    return pending as { calls: ClientToolCall[]; results: unknown[] } | null;
  }, []);

  /** Runs tools Claude asked the browser to handle (previews of on-device photos). */
  const runClientTools = useCallback(async (calls: ClientToolCall[]) => {
    let remaining = MAX_PREVIEWS - countPreviews(messagesRef.current);
    const out: unknown[] = [];
    for (const call of calls) {
      const ids = (call.input as { photo_ids?: unknown }).photo_ids;
      if (call.name !== "view_photos" || !Array.isArray(ids)) {
        out.push({ type: "tool_result", tool_use_id: call.id, content: "Unsupported tool", is_error: true });
        continue;
      }
      const blocks: unknown[] = [];
      for (const id of ids.slice(0, 12)) {
        const photo = photosRef.current.find((p) => p.id === id);
        if (!photo?.file) {
          blocks.push({ type: "text", text: `${id}: unknown id` });
          continue;
        }
        if (remaining <= 0) {
          blocks.push({ type: "text", text: "Preview limit reached; plan the rest from metadata." });
          break;
        }
        try {
          const data = await previewBase64(photo.file);
          blocks.push({ type: "text", text: `${id}${photo.createTime ? ` (taken ${photo.createTime})` : ""}:` });
          blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
          remaining--;
        } catch {
          blocks.push({ type: "text", text: `${id}: could not be read` });
        }
      }
      out.push({ type: "tool_result", tool_use_id: call.id, content: blocks });
    }
    return out;
  }, []);

  const send = useCallback(
    async (first: ApiMessage) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      try {
        let next: ApiMessage | null = first;
        for (let hops = 0; next && hops < 6; hops++) {
          const pending = await chatTurn(next);
          next = null;
          if (pending) {
            setStatus("Looking at your photos…");
            const clientResults = await runClientTools(pending.calls);
            next = { role: "user", content: [...pending.results, ...clientResults] as ContentBlock[] };
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setLive("");
        setStatus(null);
        busyRef.current = false;
        setBusy(false);
      }
    },
    [chatTurn, runClientTools],
  );

  const applySelection = useCallback(
    (selection: Selection, picked: PhotoRef[], note: string) => {
      selectionRef.current = selection;
      photosRef.current = picked;
      setPhotos(picked);
      setPlan(null);
      setChooser(null);
      void send({ role: "user", content: note });
    },
    [send],
  );

  // ---- Device / camera roll ----
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    setPreparing(`Preparing photos 0/${Math.min(files.length, MAX_DEVICE_PHOTOS)}…`);
    try {
      const { photos: picked, skipped } = await loadDevicePhotos([...files], (d, t) => setPreparing(`Preparing photos ${d}/${t}…`));
      if (!picked.length) {
        setError("None of those files could be opened as photos. HEIC files may need a phone or Safari.");
        return;
      }
      const meta = picked.map(({ id, filename, createTime, width, height }) => ({ id, filename, createTime, width, height }));
      let note = `I've picked ${picked.length} photo${picked.length === 1 ? "" : "s"} from my device.`;
      if (files.length > MAX_DEVICE_PHOTOS) note += ` (Only the first ${MAX_DEVICE_PHOTOS} were used.)`;
      if (skipped.length) note += ` (${skipped.length} couldn't be opened.)`;
      applySelection({ source: "device", photos: meta }, picked, note);
    } finally {
      setPreparing(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // ---- Google Photos ----
  const openGoogle = async (maxItems: number) => {
    if (!me?.googleConnected) {
      try {
        sessionStorage.setItem(STASH_KEY, JSON.stringify({ messages: messagesRef.current, maxItems }));
      } catch {
        /* the conversation just restarts */
      }
      // Full navigation to the OAuth route handler (not a page), so the router can't be used.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/api/auth/google";
      return;
    }
    // Open the window synchronously (inside the click) so popup blockers allow it.
    const win = window.open("about:blank", "google-photos-picker", "width=1000,height=760");
    try {
      const r = await fetch("/api/photos/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxItems }),
      });
      if (r.status === 401) {
        win?.close();
        setMe((m) => (m ? { ...m, googleConnected: false } : m));
        setError("Your Google session expired. Click Google Photos again to reconnect.");
        return;
      }
      const d = (await r.json()) as { sessionId?: string; pickerUri?: string };
      if (!d.sessionId || !d.pickerUri) throw new Error();
      if (win) win.location.href = `${d.pickerUri}/autoclose`;
      setGooglePick({ sessionId: d.sessionId, pickerUri: d.pickerUri, status: "waiting" });
    } catch {
      win?.close();
      setError("Couldn't open Google Photos. Try again, or choose photos from your device.");
    }
  };

  useEffect(() => {
    if (!googlePick || googlePick.status !== "waiting") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const poll = async () => {
      if (cancelled) return;
      if (Date.now() - started > 25 * 60_000) return setGooglePick((p) => (p ? { ...p, status: "expired" } : p));
      try {
        const r = await fetch(`/api/photos/session?id=${encodeURIComponent(googlePick.sessionId)}`);
        const d = (await r.json()) as { ready?: boolean; photos?: PhotoRef[] };
        if (!cancelled && d.ready && d.photos) {
          setGooglePick(null);
          const n = d.photos.length;
          applySelection(
            { source: "google", pickerSessionId: googlePick.sessionId },
            d.photos,
            `I've picked ${n} photo${n === 1 ? "" : "s"} from Google Photos.`,
          );
          return;
        }
      } catch {
        /* transient; keep polling */
      }
      timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [googlePick, applySelection]);

  // Thumbnails: object URLs for device photos, the image proxy for Google ones.
  const thumbs = useMemo(
    () => photos.slice(0, 40).map((p) => ({ id: p.id, alt: p.filename ?? p.id, src: p.file ? URL.createObjectURL(p.file) : imageUrl(p, 160) })),
    [photos],
  );
  useEffect(() => () => thumbs.forEach((t) => t.src.startsWith("blob:") && URL.revokeObjectURL(t.src)), [thumbs]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busyRef.current) return;
    setInput("");
    void send({ role: "user", content: t });
  };

  const disconnect = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setMe((m) => (m ? { ...m, googleConnected: false } : m));
    if (selectionRef.current.source === "google") {
      selectionRef.current = { source: "none" };
      photosRef.current = [];
      setPhotos([]);
      setPlan(null);
    }
  };

  const bubbles = toBubbles(messages);
  const showChooser = !busy && !preparing && !googlePick && (chooser || photos.length === 0);

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col px-4">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => void onFiles(e.target.files)}
      />
      <header className="flex items-center justify-between py-4">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-white">▶</span>
          <span className="font-semibold">Reelbot</span>
        </div>
        {me?.googleConnected && (
          <button onClick={disconnect} className="text-sm text-muted hover:text-foreground">
            Disconnect Google Photos
          </button>
        )}
      </header>

      <div className="flex-1 space-y-3 pb-4">
        {bubbles.length === 0 && !busy && (
          <section className="rounded-2xl border border-border bg-surface p-6">
            <h1 className="text-xl font-semibold">Turn your photos into a video</h1>
            <p className="mt-1 text-muted">
              Choose photos from your camera roll{me?.googleConfigured ? " or Google Photos" : ""}, say what you want, and
              Reelbot storyboards and renders a video you can download.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => submit(s)}
                  className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-2"
                >
                  {s}
                </button>
              ))}
            </div>
          </section>
        )}

        {bubbles.map((b, i) => (
          <Message key={i} role={b.role} text={b.text} />
        ))}
        {live && <Message role="assistant" text={live} />}
        {status && <p className="text-sm text-muted">{status}</p>}

        {thumbs.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto rounded-2xl border border-border bg-surface p-3">
            {thumbs.map((t) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={t.id} src={t.src} alt={t.alt} className="h-16 w-16 flex-none rounded object-cover" />
            ))}
            {photos.length > thumbs.length && (
              <span className="self-center px-2 text-sm text-muted">+{photos.length - thumbs.length}</span>
            )}
          </div>
        )}

        {showChooser && (
          <div className="rounded-2xl border border-border bg-surface p-4">
            <p className="text-sm font-medium">{photos.length ? "Choose different photos" : "Add photos"}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button
                onClick={() => fileRef.current?.click()}
                className="rounded-xl bg-accent px-4 py-3 text-left font-medium text-white"
              >
                From this device
                <span className="block text-xs font-normal opacity-80">Camera roll on your phone, or files on a computer</span>
              </button>
              {me?.googleConfigured && (
                <button
                  onClick={() => void openGoogle(chooser?.maxItems ?? 30)}
                  className="rounded-xl border border-border px-4 py-3 text-left font-medium hover:bg-surface-2"
                >
                  From Google Photos
                  <span className="block text-xs font-normal text-muted">
                    {me.googleConnected ? "Opens Google's photo picker" : "Sign in with Google first"}
                  </span>
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-muted">Up to {MAX_DEVICE_PHOTOS} photos. They stay on your device; Claude only sees small previews.</p>
          </div>
        )}

        {preparing && <p className="text-sm text-muted">{preparing}</p>}

        {googlePick && (
          <div className="rounded-2xl border border-border bg-surface p-4 text-sm">
            {googlePick.status === "waiting" ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>Choose photos in the Google Photos window, then click Done.</span>
                <a href={`${googlePick.pickerUri}/autoclose`} target="google-photos-picker" className="text-accent underline">
                  Window didn&apos;t open?
                </a>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span>The Google Photos picker timed out.</span>
                <button onClick={() => setGooglePick(null)} className="text-accent underline">
                  Choose again
                </button>
              </div>
            )}
          </div>
        )}

        {plan && photos.length > 0 && <VideoPanel plan={plan} photos={photos} />}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(input);
        }}
        className="sticky bottom-0 flex gap-2 bg-background py-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? "Reelbot is working…" : "Describe the video you want…"}
          disabled={busy}
          className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-4 py-2.5 outline-none focus:border-accent"
        />
        <button disabled={busy || !input.trim()} className="rounded-xl bg-accent px-4 font-medium text-white disabled:opacity-50">
          Send
        </button>
      </form>
    </div>
  );
}

function Message({ role, text }: Bubble) {
  return (
    <div className={role === "user" ? "flex justify-end" : "flex"}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${
          role === "user" ? "bg-accent text-white" : "border border-border bg-surface"
        }`}
      >
        {text}
      </div>
    </div>
  );
}
