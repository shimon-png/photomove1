"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadDeviceMedia, MAX_DEVICE_ITEMS, mediaPreviewBase64 } from "@/lib/device";
import type { ChatEvent, ClientToolCall, MediaRef, Selection, VideoPlan } from "@/lib/plan";
import { imageUrl } from "@/lib/render";
import type { ShareRequest } from "./SharePanel";
import { VideoPanel } from "./VideoPanel";
import { VoiceRecorder } from "./VoiceRecorder";

/** Raw API message as returned by the server; replayed unchanged on every request. */
type ContentBlock = { type: string; text?: string; content?: unknown };
type ApiMessage = { role: "user" | "assistant"; content: string | ContentBlock[] };
type Bubble = { role: "user" | "assistant"; text: string };
type Me = { googleConfigured: boolean; googleConnected: boolean; sharingEnabled?: boolean; shareUploads?: "blob" | "direct" };
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
  const [media, setMedia] = useState<MediaRef[]>([]);
  const [plan, setPlan] = useState<VideoPlan | null>(null);
  const [shareRequest, setShareRequest] = useState<ShareRequest | null>(null);
  const messagesRef = useRef<ApiMessage[]>([]);
  const selectionRef = useRef<Selection>({ device: [] });
  const mediaRef = useRef<MediaRef[]>([]);
  const busyRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const audioFileRef = useRef<HTMLInputElement>(null);
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
          case "share_request":
            setShareRequest({ recipientName: ev.recipientName, phone: ev.phone, nonce: Date.now() });
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
      const ids = (call.input as { media_ids?: unknown }).media_ids;
      if (call.name !== "view_media" || !Array.isArray(ids)) {
        out.push({ type: "tool_result", tool_use_id: call.id, content: "Unsupported tool", is_error: true });
        continue;
      }
      const blocks: unknown[] = [];
      for (const id of ids.slice(0, 12)) {
        const m = mediaRef.current.find((x) => x.id === id);
        if (!m) {
          blocks.push({ type: "text", text: `${id}: unknown id` });
          continue;
        }
        if (m.kind === "audio") {
          blocks.push({ type: "text", text: `${id}: voice note (${m.duration_s ?? "?"} s); it can't be previewed` });
          continue;
        }
        if (remaining <= 0) {
          blocks.push({ type: "text", text: "Preview limit reached; plan the rest from metadata." });
          break;
        }
        try {
          const data = await mediaPreviewBase64(m);
          const what = m.kind === "video" ? `video, ${m.duration_s} s; frames from start, middle, end` : "photo";
          blocks.push({ type: "text", text: `${id} (${what}${m.createTime ? `, taken ${m.createTime}` : ""}):` });
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
            setStatus("Looking at your photos and videos…");
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
    (all: MediaRef[], google: Selection["google"], note: string | null) => {
      const device = all.filter((m) => !m.baseUrl).map(({ id, kind, filename, createTime, width, height, duration_s }) => ({
        id, kind, filename, createTime, width, height, duration_s,
      }));
      selectionRef.current = { device, google };
      mediaRef.current = all;
      setMedia(all);
      setChooser(null);
      if (note) void send({ role: "user", content: note });
    },
    [send],
  );

  // ---- Device: camera roll, files, voice notes (added to the current selection) ----
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    const existing = mediaRef.current.filter((m) => !m.baseUrl);
    setPreparing(`Preparing 0/${files.length}…`);
    try {
      const { media: added, skipped } = await loadDeviceMedia(files, existing, (d, t) => setPreparing(`Preparing ${d}/${t}…`));
      if (!added.length) {
        setError("Those files couldn't be opened. HEIC photos and some video formats need a phone or Safari.");
        return;
      }
      const count = (k: MediaRef["kind"]) => added.filter((m) => m.kind === k).length;
      const parts = [
        [count("photo"), "photo"],
        [count("video"), "video"],
        [count("audio"), "voice note"],
      ]
        .filter(([n]) => n)
        .map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
      let note = `I've added ${parts.join(", ").replace(/, ([^,]*)$/, " and $1")} from my device.`;
      if (existing.length + files.length > MAX_DEVICE_ITEMS) note += ` (Only ${MAX_DEVICE_ITEMS} items in total can be used.)`;
      if (skipped.length) note += ` (${skipped.length} couldn't be opened.)`;
      const google = mediaRef.current.filter((m) => m.baseUrl);
      applySelection([...existing, ...added, ...google], selectionRef.current.google, busyRef.current ? null : note);
    } finally {
      setPreparing(null);
      if (fileRef.current) fileRef.current.value = "";
      if (audioFileRef.current) audioFileRef.current.value = "";
    }
  };

  const clearSelection = () => {
    for (const m of mediaRef.current) if (m.thumb) URL.revokeObjectURL(m.thumb);
    selectionRef.current = { device: [] };
    mediaRef.current = [];
    setMedia([]);
    setPlan(null);
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
        const d = (await r.json()) as { ready?: boolean; media?: MediaRef[] };
        if (!cancelled && d.ready && d.media) {
          setGooglePick(null);
          const n = d.media.length;
          const device = mediaRef.current.filter((m) => !m.baseUrl);
          applySelection(
            [...device, ...d.media],
            { pickerSessionId: googlePick.sessionId },
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

  // Thumbnails: object URLs for device photos, poster frames for videos, the image proxy for Google photos.
  const thumbs = useMemo(
    () =>
      media.slice(0, 60).map((m) => ({
        id: m.id,
        kind: m.kind,
        duration: m.duration_s,
        alt: m.filename ?? m.id,
        src: m.kind === "photo" ? (m.file ? URL.createObjectURL(m.file) : imageUrl(m, 160)) : m.thumb,
        own: m.kind === "photo" && Boolean(m.file),
      })),
    [media],
  );
  useEffect(() => () => thumbs.forEach((t) => t.own && t.src && URL.revokeObjectURL(t.src)), [thumbs]);

  const submit = (text: string) => {
    const t = text.trim();
    if (!t || busyRef.current) return;
    setInput("");
    void send({ role: "user", content: t });
  };

  const disconnect = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setMe((m) => (m ? { ...m, googleConnected: false } : m));
    if (selectionRef.current.google) {
      applySelection(mediaRef.current.filter((m) => !m.baseUrl), undefined, null);
      setPlan(null);
    }
  };

  const bubbles = toBubbles(messages);
  const showChooser = !busy && !preparing && !googlePick && (chooser || media.length === 0);

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col px-4">
      <input
        ref={fileRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => void addFiles([...(e.target.files ?? [])])}
      />
      <input
        ref={audioFileRef}
        type="file"
        accept="audio/*"
        multiple
        className="hidden"
        onChange={(e) => void addFiles([...(e.target.files ?? [])])}
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
            <h1 className="text-xl font-semibold">Turn your photos, clips and voice notes into a video</h1>
            <p className="mt-1 text-muted">
              Add photos and videos from your camera roll{me?.googleConfigured ? " or Google Photos" : ""}, record a voice note if you
              like, say what you want, and Reelbot storyboards and renders a video you can download.
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
          <div className="rounded-2xl border border-border bg-surface p-3">
            <div className="flex gap-1.5 overflow-x-auto">
              {thumbs.map((t) =>
                t.kind === "audio" ? (
                  <div key={t.id} className="grid h-16 w-16 flex-none place-items-center rounded bg-surface-2 text-center text-xs" title={t.alt}>
                    <span className="text-lg" aria-hidden>
                      🎙
                    </span>
                    {formatDuration(t.duration)}
                  </div>
                ) : (
                  <div key={t.id} className="relative h-16 w-16 flex-none overflow-hidden rounded bg-black">
                    {t.src && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={t.src} alt={t.alt} className="h-full w-full object-cover" />
                    )}
                    {t.kind === "video" && (
                      <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[10px] text-white">
                        ▶ {formatDuration(t.duration)}
                      </span>
                    )}
                  </div>
                ),
              )}
              {media.length > thumbs.length && <span className="self-center px-2 text-sm text-muted">+{media.length - thumbs.length}</span>}
            </div>
            {!showChooser && !busy && (
              <div className="mt-2 flex gap-3 text-xs">
                <button onClick={() => setChooser({ maxItems: 30 })} className="text-accent underline">
                  Add more
                </button>
                <button onClick={clearSelection} className="text-muted underline">
                  Clear
                </button>
              </div>
            )}
          </div>
        )}

        {showChooser && (
          <div className="rounded-2xl border border-border bg-surface p-4">
            <p className="text-sm font-medium">{media.length ? "Add more" : "Add photos, videos and voice notes"}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <button onClick={() => fileRef.current?.click()} className="rounded-xl bg-accent px-4 py-3 text-left font-medium text-white">
                Photos &amp; videos
                <span className="block text-xs font-normal opacity-80">From your camera roll, or files on a computer</span>
              </button>
              <VoiceRecorder onRecorded={(file) => void addFiles([file])} onError={setError} />
              <button
                onClick={() => audioFileRef.current?.click()}
                className="rounded-xl border border-border px-4 py-3 text-left font-medium hover:bg-surface-2"
              >
                Voice note file
                <span className="block text-xs font-normal text-muted">An audio recording you already have</span>
              </button>
              {me?.googleConfigured && (
                <button
                  onClick={() => void openGoogle(chooser?.maxItems ?? 30)}
                  className="rounded-xl border border-border px-4 py-3 text-left font-medium hover:bg-surface-2"
                >
                  From Google Photos
                  <span className="block text-xs font-normal text-muted">
                    {me.googleConnected ? "Photos only, via Google's picker" : "Sign in with Google first"}
                  </span>
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-muted">
              Up to {MAX_DEVICE_ITEMS} items. They stay on your device; Claude only sees small previews.
            </p>
            {chooser && media.length > 0 && (
              <button onClick={() => setChooser(null)} className="mt-2 text-xs text-muted underline">
                Done adding
              </button>
            )}
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

        {plan && media.length > 0 && (
          <VideoPanel
            plan={plan}
            media={media}
            sharingEnabled={Boolean(me?.sharingEnabled)}
            shareRequest={shareRequest}
            uploadMode={me?.shareUploads ?? "blob"}
          />
        )}
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

function formatDuration(s?: number) {
  if (s === undefined) return "";
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
}
